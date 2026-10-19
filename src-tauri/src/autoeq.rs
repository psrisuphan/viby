/*
 * Copyright (C) 2026 PEQdB Inc.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

const K: usize = 384;
const DEFAULT_FS: f32 = 48000.0;
const DEFAULT_STEPS: usize = 3000;
const MAX_STEPS: usize = 10_000;
const MAX_N: usize = 32;
const MAX_CURVE_POINTS: usize = 100_000;
const F_MIN: f32 = 20.0;
const F_MAX: f32 = 20000.0;

mod biquad;
mod optimizer;
use optimizer::fit;

mod target_processing;
use target_processing::{preprocess, IE_SMOOTH, OE_SMOOTH};

mod filters;
use filters::{init_hsc, init_lsc, init_pk, spectrum, Lim};

// ── Models for command ──

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoEqTargetCurve {
    pub name: String,
    #[specta(type = Vec<(i32, i32)>)]
    pub points: Vec<(f32, f32)>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoEqBand {
    pub enabled: bool,
    pub filter_type: u8,
    #[specta(type = u32)]
    pub freq: f32,
    /// Signed fractional decibels; the Specta override emits TypeScript `number`.
    #[specta(type = u32)]
    pub gain: f32,
    #[specta(type = u32)]
    pub q: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AutoEqConfigKind {
    Standard,
    Precise,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AutoEqSmoothKind {
    None,
    Ie,
    Oe,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoEqOptions {
    pub config: Option<AutoEqConfigKind>,
    pub smooth: Option<AutoEqSmoothKind>,
    pub steps: Option<usize>,
    pub sample_rate: Option<f32>,
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoEqResult {
    pub bands: Vec<AutoEqBand>,
    /// Signed fractional decibels; the Specta override emits TypeScript `number`.
    #[specta(type = u32)]
    pub preamp: f32,
    #[specta(type = u32)]
    pub loss: f32,
    /// May be negative or positive; the Specta override emits TypeScript `number`.
    #[specta(type = u32)]
    pub max_response_db: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AutoEqSpec {
    filter_type: u8,
    f0: Lim,
    gain: Lim,
    q: Lim,
}

fn standard_specs(n_bands: usize) -> Vec<AutoEqSpec> {
    (0..n_bands)
        .map(|i| match i {
            0 => AutoEqSpec {
                filter_type: 1,
                f0: Lim {
                    lo: F_MIN,
                    hi: 500.0,
                },
                gain: Lim {
                    lo: -16.0,
                    hi: 16.0,
                },
                q: Lim { lo: 0.4, hi: 3.0 },
            },
            1 => AutoEqSpec {
                filter_type: 2,
                f0: Lim {
                    lo: 3000.0,
                    hi: F_MAX,
                },
                gain: Lim {
                    lo: -16.0,
                    hi: 16.0,
                },
                q: Lim { lo: 0.4, hi: 3.0 },
            },
            _ => AutoEqSpec {
                filter_type: 0,
                f0: Lim {
                    lo: F_MIN,
                    hi: 16000.0,
                },
                gain: Lim {
                    lo: -16.0,
                    hi: 16.0,
                },
                q: Lim { lo: 0.4, hi: 4.0 },
            },
        })
        .collect()
}

fn max_response_db(
    types: &[u8],
    f0: &[f32],
    gain: &[f32],
    q: &[f32],
    freqs: &[f32; K],
    fs: f32,
) -> f32 {
    let mut response = [0.0f32; K];
    for n in 0..types.len() {
        spectrum(types[n], f0[n], gain[n], q[n], &mut response, freqs, fs);
    }
    response.into_iter().fold(f32::NEG_INFINITY, f32::max)
}

#[tauri::command]
#[specta::specta]
pub async fn run_autoeq(
    measurement: AutoEqTargetCurve,
    target: AutoEqTargetCurve,
    bands_to_optimize: Vec<AutoEqBand>,
    options: Option<AutoEqOptions>,
) -> Result<AutoEqResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_autoeq_inner(measurement, target, bands_to_optimize, options)
    })
    .await
    .map_err(|error| format!("AutoEQ worker failed: {error}"))?
}

fn run_autoeq_inner(
    measurement: AutoEqTargetCurve,
    target: AutoEqTargetCurve,
    bands_to_optimize: Vec<AutoEqBand>,
    options: Option<AutoEqOptions>,
) -> Result<AutoEqResult, String> {
    let n_bands = bands_to_optimize.len();
    if n_bands == 0 {
        return Ok(AutoEqResult {
            bands: Vec::new(),
            preamp: 0.0,
            loss: 0.0,
            max_response_db: 0.0,
        });
    }

    if n_bands > MAX_N {
        return Err(format!("AutoEQ supports at most {MAX_N} filters"));
    }

    if measurement.points.len() > MAX_CURVE_POINTS || target.points.len() > MAX_CURVE_POINTS {
        return Err(format!(
            "AutoEQ curves support at most {MAX_CURVE_POINTS} points"
        ));
    }

    if measurement.points.is_empty()
        || target.points.is_empty()
        || measurement
            .points
            .iter()
            .chain(&target.points)
            .any(|(frequency, gain)| {
                !frequency.is_finite() || *frequency <= 0.0 || !gain.is_finite()
            })
    {
        return Err("Curves must contain finite gains and positive finite frequencies".to_string());
    }

    let options = options.unwrap_or(AutoEqOptions {
        config: None,
        smooth: None,
        steps: None,
        sample_rate: None,
    });
    let config = options.config.unwrap_or(AutoEqConfigKind::Standard);
    let smooth_kind = options.smooth.unwrap_or(AutoEqSmoothKind::None);
    let steps = options.steps.unwrap_or(DEFAULT_STEPS);
    if !(1..=MAX_STEPS).contains(&steps) {
        return Err(format!("steps must be between 1 and {MAX_STEPS}"));
    }
    let fs = options.sample_rate.unwrap_or(DEFAULT_FS);
    if !fs.is_finite() || fs <= 0.0 {
        return Err("sampleRate must be a positive finite number".to_string());
    }

    let smooth_enabled = config == AutoEqConfigKind::Standard;
    let specs = standard_specs(n_bands);
    let types: Vec<u8> = specs.iter().map(|spec| spec.filter_type).collect();

    // 1. Generate K=384 log-spaced frequency sampling points
    let l_min = F_MIN.ln();
    let l_max = F_MAX.ln();
    let lr = l_max - l_min;

    let mut freqs = [0.0f32; K];
    for k in 0..K {
        freqs[k] = (l_min + (lr * k as f32) / (K as f32 - 1.0)).exp();
    }

    // 2. Precompute phi vector
    let mut phi = [0.0f32; K];
    for k in 0..K {
        phi[k] = ((std::f32::consts::PI / fs) * freqs[k]).sin().powi(2);
    }

    // Sort target and measurement points
    let mut sorted_target_points = target.points;
    sorted_target_points.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut sorted_meas_points = measurement.points;
    sorted_meas_points.sort_by(|a, b| a.0.total_cmp(&b.0));

    // Interpolation closure
    let interpolate_point = |points: &[(f32, f32)], freq: f32| -> f32 {
        if points.is_empty() {
            return 0.0;
        }
        if freq <= points[0].0 {
            return points[0].1;
        }
        if freq >= points[points.len() - 1].0 {
            return points[points.len() - 1].1;
        }

        let mut low = 0;
        let mut high = points.len() - 1;
        while low <= high {
            let mid = (low + high) >> 1;
            if (points[mid].0 - freq).abs() < 1e-5 {
                return points[mid].1;
            }
            if points[mid].0 < freq {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        let p0 = points[low - 1];
        let p1 = points[low];
        if (p1.0 - p0.0).abs() < 1e-5 {
            return p0.1;
        }
        let denom = p1.0.ln() - p0.0.ln();
        if denom.abs() < 1e-5 {
            return p0.1;
        }
        let t = (freq.ln() - p0.0.ln()) / denom;
        p0.1 + t * (p1.1 - p0.1)
    };

    let mut dst = [0.0f32; K];
    let mut src = [0.0f32; K];
    for k in 0..K {
        dst[k] = interpolate_point(&sorted_target_points, freqs[k]);
        src[k] = interpolate_point(&sorted_meas_points, freqs[k]);
    }

    // Preprocessing (demean and rolling-off treble)
    let mut r = [0.0f32; K];
    let smooth = if !smooth_enabled {
        None
    } else {
        match smooth_kind {
            AutoEqSmoothKind::Ie => Some(&IE_SMOOTH),
            AutoEqSmoothKind::Oe => Some(&OE_SMOOTH),
            AutoEqSmoothKind::None => None,
        }
    };
    let _mean = preprocess(&freqs, &dst, &src, &mut r, smooth, true);

    // Initialize filters greedily using peak finding
    let mut r_init = r;
    let mut f0 = vec![0.0f32; n_bands];
    let mut gain = vec![0.0f32; n_bands];
    let mut q = vec![0.0f32; n_bands];

    let f0_lims: Vec<Lim> = specs.iter().map(|spec| spec.f0).collect();
    let gain_lims: Vec<Lim> = specs.iter().map(|spec| spec.gain).collect();
    let q_lims: Vec<Lim> = specs.iter().map(|spec| spec.q).collect();

    for n in 0..n_bands {
        let p = match types[n] {
            1 => init_lsc(&r_init, &freqs, fs, f0_lims[n], gain_lims[n], q_lims[n]),
            2 => init_hsc(&r_init, &freqs, fs, f0_lims[n], gain_lims[n], q_lims[n]),
            _ => init_pk(&r_init, &freqs, f0_lims[n], gain_lims[n], q_lims[n]),
        };

        let mut w = [0.0f32; K];
        spectrum(types[n], p.f0, -p.gain, p.q, &mut w, &freqs, fs);
        for k in 0..K {
            r_init[k] += w[k];
        }

        f0[n] = p.f0;
        gain[n] = p.gain;
        q[n] = p.q;
    }

    // Global Optimization using AdaBelief Gradient Descent (3000 steps),
    // including the fitted overall gain offset from autoeq-c.
    let mut amp = 0.0f32;
    let loss = fit(
        steps, n_bands, &types, &mut f0, &mut gain, &mut q, &mut amp, true, &f0_lims, &gain_lims,
        &q_lims, &r, &phi, fs,
    );

    // Create clean rounded PEQ bands
    let mut bands = Vec::with_capacity(n_bands);
    for n in 0..n_bands {
        bands.push(AutoEqBand {
            enabled: true,
            filter_type: types[n],
            freq: f0[n].clamp(f0_lims[n].lo, f0_lims[n].hi).round(),
            gain: (gain[n].clamp(gain_lims[n].lo, gain_lims[n].hi) * 10.0).round() / 10.0,
            q: (q[n].clamp(q_lims[n].lo, q_lims[n].hi) * 100.0).round() / 100.0,
        });
    }
    let max_response_db =
        (max_response_db(&types, &f0, &gain, &q, &freqs, fs) * 10.0).round() / 10.0;
    let total_preamp = _mean + amp;
    let preamp_val = if total_preamp + max_response_db > 0.0 {
        -max_response_db
    } else {
        total_preamp
    };
    let preamp = (preamp_val * 10.0).round() / 10.0;
    bands.sort_by(|a, b| {
        a.freq
            .partial_cmp(&b.freq)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(AutoEqResult {
        bands,
        preamp,
        loss,
        max_response_db,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rust_autoeq_optimization() {
        let measurement = AutoEqTargetCurve {
            name: "Flat Measurement".to_string(),
            points: vec![
                (20.0, 0.0),
                (100.0, 0.0),
                (1000.0, 0.0),
                (10000.0, 0.0),
                (20000.0, 0.0),
            ],
        };

        let target = AutoEqTargetCurve {
            name: "Custom Target Curve".to_string(),
            points: vec![
                (20.0, 4.0),
                (100.0, 4.0),
                (1000.0, 0.0),
                (10000.0, -2.0),
                (20000.0, -2.0),
            ],
        };

        let bands_to_optimize = vec![
            AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 100.0,
                gain: 0.0,
                q: 1.0,
            },
            AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 1000.0,
                gain: 0.0,
                q: 1.0,
            },
            AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 5000.0,
                gain: 0.0,
                q: 1.0,
            },
        ];

        let result = run_autoeq_inner(measurement, target, bands_to_optimize, None).unwrap();

        assert_eq!(result.bands.len(), 3);
        assert!(result.preamp.is_finite());
        assert!(result.loss.is_finite());
        assert!(result.max_response_db.is_finite());

        for band in &result.bands {
            assert!(band.enabled);
            assert!(band.freq >= F_MIN && band.freq <= F_MAX);
            assert!(band.gain >= -16.0 && band.gain <= 16.0);
            assert!(band.q >= 0.4 && band.q <= 4.0);
        }
    }

    #[test]
    fn standard_specs_match_autoeq_c_layout() {
        let one = standard_specs(1);
        assert_eq!(one[0].filter_type, 1);
        assert_eq!(one[0].q, Lim { lo: 0.4, hi: 3.0 });

        let two = standard_specs(2);
        assert_eq!(
            two.iter().map(|spec| spec.filter_type).collect::<Vec<_>>(),
            vec![1, 2]
        );

        let eight = standard_specs(8);
        assert_eq!(eight[0].filter_type, 1);
        assert_eq!(eight[1].filter_type, 2);
        assert!(eight[2..].iter().all(|spec| spec.filter_type == 0));
        assert!(
            eight[2..]
                .iter()
                .all(|spec| spec.q == Lim { lo: 0.4, hi: 4.0 })
        );

        assert_eq!(standard_specs(32).len(), 32);
    }

    #[test]
    fn rejects_more_than_autoeq_c_max_filters() {
        let measurement = AutoEqTargetCurve {
            name: "Flat Measurement".to_string(),
            points: vec![(20.0, 0.0), (20000.0, 0.0)],
        };
        let target = AutoEqTargetCurve {
            name: "Target".to_string(),
            points: vec![(20.0, 0.0), (20000.0, 0.0)],
        };
        let bands_to_optimize = (0..=MAX_N)
            .map(|_| AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 1000.0,
                gain: 0.0,
                q: 1.0,
            })
            .collect();

        let err = run_autoeq_inner(measurement, target, bands_to_optimize, None).unwrap_err();
        assert!(err.contains("at most 32"));
    }

    #[test]
    fn rejects_non_finite_curve_points() {
        let measurement = AutoEqTargetCurve {
            name: "Invalid".to_string(),
            points: vec![(f32::NAN, 0.0)],
        };
        let target = AutoEqTargetCurve {
            name: "Target".to_string(),
            points: vec![(1000.0, 0.0)],
        };
        let bands = vec![AutoEqBand {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain: 0.0,
            q: 1.0,
        }];

        let error = run_autoeq_inner(measurement, target, bands, None).unwrap_err();
        assert!(error.contains("finite"));
    }

    #[test]
    fn rejects_unbounded_optimization_steps() {
        let measurement = AutoEqTargetCurve {
            name: "Measurement".to_string(),
            points: vec![(20.0, 0.0), (20000.0, 0.0)],
        };
        let target = AutoEqTargetCurve {
            name: "Target".to_string(),
            points: vec![(20.0, 0.0), (20000.0, 0.0)],
        };
        let bands = vec![AutoEqBand {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain: 0.0,
            q: 1.0,
        }];

        let error = run_autoeq_inner(
            measurement,
            target,
            bands,
            Some(AutoEqOptions {
                config: None,
                smooth: None,
                steps: Some(MAX_STEPS + 1),
                sample_rate: None,
            }),
        )
        .unwrap_err();
        assert!(error.contains("steps"));
    }

    #[test]
    fn rejects_unbounded_curve_points() {
        let measurement = AutoEqTargetCurve {
            name: "Measurement".to_string(),
            points: vec![(1000.0, 0.0); MAX_CURVE_POINTS + 1],
        };
        let target = AutoEqTargetCurve {
            name: "Target".to_string(),
            points: vec![(1000.0, 0.0)],
        };
        let bands = vec![AutoEqBand {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain: 0.0,
            q: 1.0,
        }];

        let error = run_autoeq_inner(measurement, target, bands, None).unwrap_err();
        assert!(error.contains("points"));
    }

    #[test]
    fn precise_config_disables_smoothing() {
        let measurement = AutoEqTargetCurve {
            name: "Flat Measurement".to_string(),
            points: vec![(20.0, 0.0), (1000.0, 0.0), (20000.0, 0.0)],
        };
        let target = AutoEqTargetCurve {
            name: "Target".to_string(),
            points: vec![(20.0, 2.0), (1000.0, 0.0), (20000.0, -2.0)],
        };
        let bands_to_optimize = vec![
            AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 100.0,
                gain: 0.0,
                q: 1.0,
            },
            AutoEqBand {
                enabled: true,
                filter_type: 0,
                freq: 1000.0,
                gain: 0.0,
                q: 1.0,
            },
        ];

        let result = run_autoeq_inner(
            measurement,
            target,
            bands_to_optimize,
            Some(AutoEqOptions {
                config: Some(AutoEqConfigKind::Precise),
                smooth: Some(AutoEqSmoothKind::Ie),
                steps: Some(2),
                sample_rate: Some(DEFAULT_FS),
            }),
        )
        .unwrap();

        assert_eq!(result.bands.len(), 2);
        assert!(result.loss.is_finite());
    }
}

#[cfg(test)]
#[path = "autoeq_baseline_tests.rs"]
mod baseline_tests;

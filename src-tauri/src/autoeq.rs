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
use biquad::{bw_to_q, hsc, lsc, pk, q_to_bw, sq};

fn grad(
    n_bands: usize,
    types: &[u8],
    x: &[f32],
    g: &mut [f32],
    r: &[f32],
    phi: &[f32; K],
    opt_amp: bool,
    fs: f32,
) -> f32 {
    let r_k = 1.0 / K as f32;

    let mut dy_dw0 = [[0.0f32; K]; MAX_N];
    let mut dy_dgain = [[0.0f32; K]; MAX_N];
    let mut dy_dbw = [[0.0f32; K]; MAX_N];
    let mut w0_v = [0.0f32; MAX_N];

    let mut pred = [0.0f32; K];
    let amp_idx = 3 * n_bands;
    let pred_init = if opt_amp {
        10.0f32.powf(x[amp_idx] / 10.0)
    } else {
        1.0
    };
    pred.fill(pred_init);

    for n in 0..n_bands {
        let f0 = x[n].exp();
        let gain = x[n_bands + n];
        let bw = x[2 * n_bands + n];

        let a_val = 10.0f32.powf(gain / 40.0);
        let w0 = (2.0 * std::f32::consts::PI / fs) * f0;
        let cos_w = w0.cos();
        let sin_w = w0.sin();
        let k_q = (0.5 * std::f32::consts::LN_2 * bw).sinh();
        let alpha = sin_w * k_q;

        w0_v[n] = w0;

        let s = match types[n] {
            1 => lsc(a_val, cos_w, alpha),
            2 => hsc(a_val, cos_w, alpha),
            _ => pk(a_val, cos_w, alpha),
        };

        let da_dgain = a_val * std::f32::consts::LN_10 / 40.0;
        let dalpha_dw0 = cos_w * k_q;
        let dalpha_dbw =
            sin_w * (0.5 * std::f32::consts::LN_2 * bw).cosh() * 0.5 * std::f32::consts::LN_2;
        let dcos_dw0 = -sin_w;

        let b_x0 = sq(s.b0 + s.b1 + s.b2);
        let b_x1 = -4.0 * (s.b0 * s.b1 + 4.0 * s.b0 * s.b2 + s.b1 * s.b2);
        let b_x2 = 16.0 * s.b0 * s.b2;

        let a_x0 = sq(s.a0 + s.a1 + s.a2);
        let a_x1 = -4.0 * (s.a0 * s.a1 + 4.0 * s.a0 * s.a2 + s.a1 * s.a2);
        let a_x2 = 16.0 * s.a0 * s.a2;

        let ba = s.b0 + s.b1 + s.b2;
        let aa = s.a0 + s.a1 + s.a2;

        for k in 0..K {
            let phi_k = phi[k];

            let b_poly = b_x0 + phi_k * (b_x1 + phi_k * b_x2);
            let a_poly = a_x0 + phi_k * (a_x1 + phi_k * a_x2);

            pred[k] *= b_poly / a_poly;

            // backward
            let _8phi2 = 8.0 * phi_k * phi_k;
            let _2phi = 2.0 * phi_k;

            let bm = (20.0 / std::f32::consts::LN_10) / b_poly;
            let am = (-20.0 / std::f32::consts::LN_10) / a_poly;

            let dy_db0 = bm * (ba - _2phi * (s.b1 + 4.0 * s.b2) + _8phi2 * s.b2);
            let dy_db1 = bm * (ba - _2phi * (s.b0 + s.b2));
            let dy_db2 = bm * (ba - _2phi * (4.0 * s.b0 + s.b1) + _8phi2 * s.b0);

            let dy_da0 = am * (aa - _2phi * (s.a1 + 4.0 * s.a2) + _8phi2 * s.a2);
            let dy_da1 = am * (aa - _2phi * (s.a0 + s.a2));
            let dy_da2 = am * (aa - _2phi * (4.0 * s.a0 + s.a1) + _8phi2 * s.a0);

            let dy_d_a = dy_db0 * s.db0_da
                + dy_db1 * s.db1_da
                + dy_db2 * s.db2_da
                + dy_da0 * s.da0_da
                + dy_da1 * s.da1_da
                + dy_da2 * s.da2_da;

            let dy_dalpha = dy_db0 * s.db0_dalpha
                + dy_db2 * s.db2_dalpha
                + dy_da0 * s.da0_dalpha
                + dy_da2 * s.da2_dalpha;

            let dy_dcos = dy_db0 * s.db0_dcos
                + dy_db1 * s.db1_dcos
                + dy_db2 * s.db2_dcos
                + dy_da0 * s.da0_dcos
                + dy_da1 * s.da1_dcos
                + dy_da2 * s.da2_dcos;

            dy_dw0[n][k] = dy_dalpha * dalpha_dw0 + dy_dcos * dcos_dw0;
            dy_dgain[n][k] = dy_d_a * da_dgain;
            dy_dbw[n][k] = dy_dalpha * dalpha_dbw;
        }
    }

    let mut loss = 0.0;
    let mut dl_dy = [0.0f32; K];
    let mut dl_dy_sum = 0.0;

    for k in 0..K {
        let d = 10.0 * pred[k].log10() - r[k];
        loss += d * d;
        dl_dy[k] = 2.0 * d;
        dl_dy_sum += dl_dy[k];
    }

    loss *= r_k;
    g[amp_idx] = if opt_amp { dl_dy_sum * r_k } else { 0.0 };

    for n in 0..n_bands {
        let mut glf = 0.0;
        let mut ggain = 0.0;
        let mut gbw = 0.0;

        for k in 0..K {
            glf += dl_dy[k] * dy_dw0[n][k];
            ggain += dl_dy[k] * dy_dgain[n][k];
            gbw += dl_dy[k] * dy_dbw[n][k];
        }

        g[n] = glf * r_k * w0_v[n];
        g[n_bands + n] = ggain * r_k;
        g[2 * n_bands + n] = gbw * r_k;
    }

    loss
}

struct AdaBelief {
    m: Vec<f32>,
    s: Vec<f32>,
    b1: f32,
    b2: f32,
    b1t: f32,
    b2t: f32,
    eps: f32,
    eps_root: f32,
    lr: f32,
}

impl AdaBelief {
    fn new(size: usize) -> Self {
        Self {
            m: vec![0.0; size],
            s: vec![0.0; size],
            b1: 0.9,
            b2: 0.99,
            b1t: 0.9,
            b2t: 0.99,
            eps: 1e-12,
            eps_root: 1e-12,
            lr: 3e-2,
        }
    }

    fn step(&mut self, x: &mut [f32], g: &[f32]) {
        for w in 0..x.len() {
            self.m[w] = self.b1 * self.m[w] + (1.0 - self.b1) * g[w];
            self.s[w] = self.b2 * self.s[w] + (1.0 - self.b2) * sq(g[w] - self.m[w]);

            let m_hat = self.m[w] / (1.0 - self.b1t);
            let s_hat = self.s[w] / (1.0 - self.b2t);

            let den = (s_hat + self.eps_root).sqrt() + self.eps;
            x[w] -= self.lr * m_hat / den;
        }

        self.b1t *= self.b1;
        self.b2t *= self.b2;
    }
}

mod target_processing;
use target_processing::{preprocess, IE_SMOOTH, OE_SMOOTH};

mod filters;
use filters::{init_hsc, init_lsc, init_pk, spectrum, Lim};

fn fit(
    steps: usize,
    n_bands: usize,
    types: &[u8],
    f0: &mut [f32],
    gain: &mut [f32],
    q: &mut [f32],
    amp: &mut f32,
    opt_amp: bool,
    f0_lim: &[Lim],
    gain_lim: &[Lim],
    q_lim: &[Lim],
    r: &[f32],
    phi: &[f32; K],
    fs: f32,
) -> f32 {
    let lf_lim: Vec<Lim> = f0_lim
        .iter()
        .map(|lim| Lim {
            lo: lim.lo.ln(),
            hi: lim.hi.ln(),
        })
        .collect();
    let bw_lim: Vec<Lim> = q_lim
        .iter()
        .map(|lim| Lim {
            lo: q_to_bw(lim.hi),
            hi: q_to_bw(lim.lo),
        })
        .collect();

    let mut x = vec![0.0f32; 3 * n_bands + 1];
    for n in 0..n_bands {
        x[n] = f0[n].ln();
        x[n_bands + n] = gain[n];
        x[2 * n_bands + n] = q_to_bw(q[n]);
    }
    let amp_idx = 3 * n_bands;
    x[amp_idx] = if opt_amp { *amp } else { 0.0 };

    let mut g = vec![0.0f32; 3 * n_bands + 1];
    let mut best = vec![0.0f32; 3 * n_bands + 1];
    let mut best_loss = 1e9f32;

    let mut opt = AdaBelief::new(3 * n_bands + 1);

    for _step in 0..steps {
        let loss = grad(n_bands, types, &x, &mut g, r, phi, opt_amp, fs);

        opt.step(&mut x, &g);

        // Box constraints via projection
        for n in 0..n_bands {
            // f0
            let lf = x[n];
            let clamped = lf.clamp(lf_lim[n].lo, lf_lim[n].hi);
            x[n] = clamped;
            if clamped != lf {
                opt.m[n] = 0.0;
            }

            // gain
            let gn = x[n_bands + n];
            let clamped = gn.clamp(gain_lim[n].lo, gain_lim[n].hi);
            x[n_bands + n] = clamped;
            if clamped != gn {
                opt.m[n_bands + n] = 0.0;
            }

            // bw
            let bw = x[2 * n_bands + n];
            let bw_lo = bw_lim[n].lo.min(bw_lim[n].hi);
            let bw_hi = bw_lim[n].lo.max(bw_lim[n].hi);
            let clamped = bw.clamp(bw_lo, bw_hi);
            x[2 * n_bands + n] = clamped;
            if clamped != bw {
                opt.m[2 * n_bands + n] = 0.0;
            }
        }

        if loss < best_loss {
            best_loss = loss;
            best.copy_from_slice(&x);
        }
    }

    for n in 0..n_bands {
        f0[n] = best[n].exp();
        gain[n] = best[n_bands + n];
        q[n] = bw_to_q(best[2 * n_bands + n]);
    }
    if opt_amp {
        *amp = best[amp_idx];
    }

    best_loss
}

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

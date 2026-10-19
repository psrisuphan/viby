/*
 * Copyright (C) 2026 PEQdB Inc.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

use super::K;

pub(super) struct SmoothConfig {
    smooth_lo: f32,
    smooth_hi: f32,
    smooth_f0: f32,
    smooth_f1: f32,
    bias_lo: f32,
    bias_md: f32,
    bias_hi: f32,
    bias_f0: f32,
    bias_f1: f32,
    bias_f2: f32,
    bias_f3: f32,
    clip_f: f32,
}

pub(super) const IE_SMOOTH: SmoothConfig = SmoothConfig {
    smooth_lo: 0.3,
    smooth_hi: 0.03,
    smooth_f0: 3000.0,
    smooth_f1: 12000.0,
    bias_lo: 0.0,
    bias_md: 0.15,
    bias_hi: 0.03,
    bias_f0: 10000.0,
    bias_f1: 13000.0,
    bias_f2: 14000.0,
    bias_f3: 20000.0,
    clip_f: 18500.0,
};

pub(super) const OE_SMOOTH: SmoothConfig = SmoothConfig {
    smooth_lo: 0.3,
    smooth_hi: 0.03,
    smooth_f0: 5000.0,
    smooth_f1: 15000.0,
    bias_lo: 0.0,
    bias_md: 0.3,
    bias_hi: 0.2,
    bias_f0: 6000.0,
    bias_f1: 9000.0,
    bias_f2: 9000.0,
    bias_f3: 20000.0,
    clip_f: 17000.0,
};

fn sgm(x: f32, x0: f32, x1: f32) -> f32 {
    let smooth = 4.0;
    let k = smooth / (x1 - x0);
    let m = 0.5 * (x0 + x1);
    let y = k * (x - m);
    0.5 * (0.5 * y).tanh() + 0.5
}

fn search(x: &[f32; K], v: f32) -> usize {
    let mut idx = 0;
    let mut best = 1e9f32;
    for i in 0..K {
        let d = (x[i] - v).abs();
        if d < best {
            best = d;
            idx = i;
        }
    }
    idx
}

fn adaptive_smooth(s: &SmoothConfig, f: &[f32; K], r: &mut [f32; K]) {
    const H: isize = 48;
    let smooth_l0 = s.smooth_f0.ln();
    let smooth_l1 = s.smooth_f1.ln();
    let bias_l0 = s.bias_f0.ln();
    let bias_l1 = s.bias_f1.ln();
    let bias_l2 = s.bias_f2.ln();
    let bias_l3 = s.bias_f3.ln();

    let x = *r;
    let clip_idx = search(f, s.clip_f) as isize;

    for k in 0..K {
        let f_k = f[k];
        let l = f_k.ln();
        let x_k = x[k];

        let sigma = s.smooth_lo + (s.smooth_hi - s.smooth_lo) * sgm(l, smooth_l0, smooth_l1);
        let bias = s.bias_lo
            + (s.bias_md - s.bias_lo) * sgm(l, bias_l0, bias_l1)
            + (s.bias_hi - s.bias_md) * sgm(l, bias_l2, bias_l3);

        let mut a = 0.0;
        let mut c = 0.0;

        for j in -H..=H {
            let mut s_idx = k as isize + j;
            if s_idx < 0 {
                s_idx = 0;
            } else if s_idx > clip_idx {
                s_idx = clip_idx;
            }

            let x_s = x[s_idx as usize];
            let d_spatial = (j as f32 * sigma) * (j as f32 * sigma);
            let d_range = bias * (x_s - x_k);

            let w = (-0.5 * d_spatial + d_range).exp();

            a += w * x_s;
            c += w;
        }

        r[k] = a / (if c == 0.0 { 1.0 } else { c });
    }
}

fn treble_rolloff(f: &[f32; K], r: &mut [f32; K], f_treble: f32) {
    let treble_idx = search(f, f_treble);
    let n_treble = K - treble_idx;
    let inv = 1.0 / (n_treble as f32 - 1.0).max(1.0);

    for i in 0..n_treble {
        let t = i as f32 * inv;
        let w = (0.5 * std::f32::consts::PI * t).cos();
        r[treble_idx + i] *= w;
    }
}

pub(super) fn preprocess(
    f: &[f32; K],
    dst: &[f32; K],
    src: &[f32; K],
    r: &mut [f32; K],
    smooth: Option<&SmoothConfig>,
    demean: bool,
) -> f32 {
    let f_treble_smooth = 16000.0f32;
    let f_treble_unsmooth = 18500.0f32;

    let mut b = *src;
    if let Some(s) = smooth {
        adaptive_smooth(s, f, &mut b);
    }

    for k in 0..K {
        r[k] = dst[k] - b[k];
    }

    let mut mean = 0.0;
    if demean {
        let mut sum = 0.0;
        for k in 0..K {
            sum += r[k];
        }
        mean = sum / K as f32;
        for k in 0..K {
            r[k] -= mean;
        }
    }

    treble_rolloff(
        f,
        r,
        if smooth.is_some() {
            f_treble_smooth
        } else {
            f_treble_unsmooth
        },
    );

    mean
}

#[derive(Clone, Copy)]
pub(super) struct Peak {
    pub(super) width: f32,
    pub(super) height: f32,
    pub(super) idx: isize,
}

pub(super) fn largest_peak(x: &[f32; K], f: &[f32; K], lim_lo: f32, lim_hi: f32) -> Peak {
    let mut peaks = Vec::new();

    let mut i = 1;
    while i < K - 1 {
        if f[i] < lim_lo || f[i] > lim_hi {
            i += 1;
            continue;
        }
        if x[i - 1] >= x[i] {
            i += 1;
            continue;
        }

        let mut i_ahead = i + 1;
        while i_ahead < K - 1 && x[i_ahead] == x[i] {
            i_ahead += 1;
        }

        if x[i_ahead] < x[i] {
            let left_edge = i;
            let right_edge = i_ahead - 1;
            peaks.push((left_edge + right_edge) / 2);
            i = i_ahead;
        } else {
            i += 1;
        }
    }

    let n = peaks.len();
    let mut prominences = vec![0.0f32; n];
    let mut left_bases = vec![0usize; n];
    let mut right_bases = vec![0usize; n];

    for p in 0..n {
        let peak = peaks[p];
        let x_peak = x[peak];

        left_bases[p] = peak;
        let mut left_min = x_peak;
        let mut idx = peak;
        while idx > 0 && x[idx] <= x_peak {
            if x[idx] < left_min {
                left_min = x[idx];
                left_bases[p] = idx;
            }
            idx -= 1;
        }

        right_bases[p] = peak;
        let mut right_min = x_peak;
        let mut idx = peak;
        while idx < K && x[idx] <= x_peak {
            if x[idx] < right_min {
                right_min = x[idx];
                right_bases[p] = idx;
            }
            idx += 1;
        }

        prominences[p] = x_peak - left_min.max(right_min);
    }

    let mut largest = Peak {
        width: 0.0,
        height: 0.0,
        idx: -1,
    };
    let mut largest_size = 0.0f32;

    for p in 0..n {
        let i_min = left_bases[p];
        let i_max = right_bases[p];
        let peak = peaks[p];

        let x_peak = x[peak];
        let height = x_peak - 0.5 * prominences[p];

        let mut idx = peak;
        while idx > i_min && height < x[idx] {
            idx -= 1;
        }

        let mut left_ip = idx as f32;
        if x[idx] < height && idx + 1 < K {
            left_ip += (height - x[idx]) / (x[idx + 1] - x[idx]);
        }

        let mut idx = peak;
        while idx < i_max && height < x[idx] {
            idx += 1;
        }

        let mut right_ip = idx as f32;
        if x[idx] < height && idx > 0 {
            right_ip -= (height - x[idx]) / (x[idx - 1] - x[idx]);
        }

        let width = right_ip - left_ip;
        let size = width * x_peak;

        if size > largest_size {
            largest = Peak {
                width,
                height: x_peak,
                idx: peak as isize,
            };
            largest_size = size;
        }
    }

    largest
}

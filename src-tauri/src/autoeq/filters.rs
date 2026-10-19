/*
 * Copyright (C) 2026 PEQdB Inc.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

use super::biquad::{hsc, lsc, pk, sq};
use super::target_processing::largest_peak;
use super::K;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Lim {
    pub(super) lo: f32,
    pub(super) hi: f32,
}

pub(super) struct FilterParams {
    pub(super) f0: f32,
    pub(super) gain: f32,
    pub(super) q: f32,
}

pub(super) fn init_pk(
    y: &[f32; K],
    f: &[f32; K],
    lim_f0: Lim,
    lim_gain: Lim,
    lim_q: Lim,
) -> FilterParams {
    let mut rect_peak = [0.0f32; K];
    let mut rect_dip = [0.0f32; K];
    for k in 0..K {
        rect_peak[k] = y[k].max(0.0);
        rect_dip[k] = (-y[k]).max(0.0);
    }

    let peak = largest_peak(&rect_peak, f, lim_f0.lo, lim_f0.hi);
    let dip = largest_peak(&rect_dip, f, lim_f0.lo, lim_f0.hi);

    let p = if peak.width * peak.height > dip.width * dip.height {
        peak
    } else {
        dip
    };

    if p.idx == -1 {
        return FilterParams {
            f0: 1000.0,
            gain: 0.0,
            q: 1.0,
        };
    }

    let f0 = f[p.idx as usize];
    let mut gain = if p.idx == peak.idx {
        peak.height
    } else {
        -dip.height
    };

    let bw = p.width * (f[1] / f[0]).log2();
    let bw_exp2 = 2.0f32.powf(bw);
    let mut q = bw_exp2.sqrt() / (bw_exp2 - 1.0);

    gain = gain.clamp(lim_gain.lo, lim_gain.hi);
    q = q.clamp(lim_q.lo, lim_q.hi);
    if q.is_nan() || q.is_infinite() {
        q = 1.0;
    }

    FilterParams { f0, gain, q }
}

pub(super) fn init_lsc(
    y: &[f32; K],
    f: &[f32; K],
    fs: f32,
    mut lim_f0: Lim,
    lim_gain: Lim,
    lim_q: Lim,
) -> FilterParams {
    lim_f0.lo = lim_f0.lo.max(40.0);
    lim_f0.hi = lim_f0.hi.min(10000.0);

    let mut best = 0.0f32;
    let mut best_idx = 0;

    let mut sum = 0.0f32;
    for k in 0..K {
        sum += y[k];
        let avg = (sum / (k + 1) as f32).abs();
        if avg > best {
            best = avg;
            best_idx = k;
        }
    }

    let mut f0 = f[best_idx];
    let mut q = std::f32::consts::FRAC_1_SQRT_2;

    f0 = f0.clamp(lim_f0.lo, lim_f0.hi);
    q = q.clamp(lim_q.lo, lim_q.hi);

    let mut w = [0.0f32; K];
    spectrum(1, f0, 1.0, q, &mut w, f, fs);

    let mut p = 0.0f32;
    let mut c = 0.0f32;
    for k in 0..K {
        p += w[k] * y[k];
        c += w[k];
    }

    let mut gain = p / if c == 0.0 { 1.0 } else { c };
    gain = gain.clamp(lim_gain.lo, lim_gain.hi);

    FilterParams { f0, gain, q }
}

pub(super) fn init_hsc(
    y: &[f32; K],
    f: &[f32; K],
    fs: f32,
    mut lim_f0: Lim,
    lim_gain: Lim,
    lim_q: Lim,
) -> FilterParams {
    lim_f0.lo = lim_f0.lo.max(40.0);
    lim_f0.hi = lim_f0.hi.min(10000.0);

    let mut best = 0.0f32;
    let mut best_idx = K - 1;

    let mut sum = 0.0f32;
    for k in 0..K {
        sum += y[K - 1 - k];
        let avg = (sum / (k + 1) as f32).abs();
        if avg > best {
            best = avg;
            best_idx = K - 1 - k;
        }
    }

    let mut f0 = f[best_idx];
    let mut q = std::f32::consts::FRAC_1_SQRT_2;

    f0 = f0.clamp(lim_f0.lo, lim_f0.hi);
    q = q.clamp(lim_q.lo, lim_q.hi);

    let mut w = [0.0f32; K];
    spectrum(2, f0, 1.0, q, &mut w, f, fs);

    let mut p = 0.0f32;
    let mut c = 0.0f32;
    for k in 0..K {
        p += w[k] * y[k];
        c += w[k];
    }

    let mut gain = p / if c == 0.0 { 1.0 } else { c };
    gain = gain.clamp(lim_gain.lo, lim_gain.hi);

    FilterParams { f0, gain, q }
}

pub(super) fn spectrum(
    filter_type: u8,
    f0: f32,
    gain: f32,
    q: f32,
    y: &mut [f32; K],
    f: &[f32; K],
    fs: f32,
) {
    let a_val = 10.0f32.powf(gain / 40.0);
    let w0 = (2.0 * std::f32::consts::PI / fs) * f0;
    let cos_w = w0.cos();
    let sin_w = w0.sin();
    let alpha = sin_w * 0.5 / q;

    let s = match filter_type {
        1 => lsc(a_val, cos_w, alpha),
        2 => hsc(a_val, cos_w, alpha),
        _ => pk(a_val, cos_w, alpha),
    };

    let b_x0 = sq(s.b0 + s.b1 + s.b2);
    let b_x1 = -4.0 * (s.b0 * s.b1 + 4.0 * s.b0 * s.b2 + s.b1 * s.b2);
    let b_x2 = 16.0 * s.b0 * s.b2;
    let a_x0 = sq(s.a0 + s.a1 + s.a2);
    let a_x1 = -4.0 * (s.a0 * s.a1 + 4.0 * s.a0 * s.a2 + s.a1 * s.a2);
    let a_x2 = 16.0 * s.a0 * s.a2;

    for k in 0..K {
        let phi_k = ((std::f32::consts::PI / fs) * f[k]).sin().powi(2);
        let b_poly = b_x0 + phi_k * (b_x1 + phi_k * b_x2);
        let a_poly = a_x0 + phi_k * (a_x1 + phi_k * a_x2);

        y[k] += 10.0 * (b_poly / a_poly).log10();
    }
}

/*
 * Copyright (C) 2026 PEQdB Inc.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

use super::biquad::{bw_to_q, hsc, lsc, pk, q_to_bw, sq};
use super::filters::Lim;
use super::{K, MAX_N};

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

pub(super) fn fit(
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

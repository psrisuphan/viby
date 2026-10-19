/*
 * Copyright (C) 2026 PEQdB Inc.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

pub(super) struct Biquad {
    pub(super) b0: f32,
    pub(super) db0_da: f32,
    pub(super) db0_dalpha: f32,
    pub(super) db0_dcos: f32,
    pub(super) b1: f32,
    pub(super) db1_da: f32,
    pub(super) db1_dcos: f32,
    pub(super) b2: f32,
    pub(super) db2_da: f32,
    pub(super) db2_dalpha: f32,
    pub(super) db2_dcos: f32,
    pub(super) a0: f32,
    pub(super) da0_da: f32,
    pub(super) da0_dalpha: f32,
    pub(super) da0_dcos: f32,
    pub(super) a1: f32,
    pub(super) da1_da: f32,
    pub(super) da1_dcos: f32,
    pub(super) a2: f32,
    pub(super) da2_da: f32,
    pub(super) da2_dalpha: f32,
    pub(super) da2_dcos: f32,
}

pub(super) fn pk(a_val: f32, cos_w: f32, alpha: f32) -> Biquad {
    let r_a = 1.0 / a_val;
    Biquad {
        b0: a_val * alpha + 1.0,
        db0_da: alpha,
        db0_dalpha: a_val,
        db0_dcos: 0.0,

        b1: -2.0 * cos_w,
        db1_da: 0.0,
        db1_dcos: -2.0,

        b2: -a_val * alpha + 1.0,
        db2_da: -alpha,
        db2_dalpha: -a_val,
        db2_dcos: 0.0,

        a0: (a_val + alpha) * r_a,
        da0_da: -alpha * r_a * r_a,
        da0_dalpha: r_a,
        da0_dcos: 0.0,

        a1: -2.0 * cos_w,
        da1_da: 0.0,
        da1_dcos: -2.0,

        a2: (a_val - alpha) * r_a,
        da2_da: alpha * r_a * r_a,
        da2_dalpha: -r_a,
        da2_dcos: 0.0,
    }
}

pub(super) fn lsc(a_val: f32, cos_w: f32, alpha: f32) -> Biquad {
    let p1 = a_val + 1.0;
    let m1 = a_val - 1.0;
    let sqrt_a = a_val.sqrt();
    let k = 2.0 * sqrt_a * alpha;
    let dk_da = alpha / sqrt_a;
    let dk_dalpha = 2.0 * sqrt_a;

    Biquad {
        b0: a_val * (-cos_w * m1 + k + p1),
        db0_da: a_val * dk_da - a_val * cos_w + a_val - cos_w * m1 + k + p1,
        db0_dalpha: a_val * dk_dalpha,
        db0_dcos: -a_val * m1,

        b1: 2.0 * a_val * (-cos_w * p1 + m1),
        db1_da: -2.0 * a_val * cos_w + 2.0 * a_val - 2.0 * cos_w * p1 + 2.0 * m1,
        db1_dcos: -2.0 * a_val * p1,

        b2: a_val * (-cos_w * m1 - k + p1),
        db2_da: -a_val * dk_da - a_val * cos_w + a_val - cos_w * m1 - k + p1,
        db2_dalpha: -a_val * dk_dalpha,
        db2_dcos: -a_val * m1,

        a0: cos_w * m1 + k + p1,
        da0_da: dk_da + cos_w + 1.0,
        da0_dalpha: dk_dalpha,
        da0_dcos: m1,

        a1: -2.0 * cos_w * p1 - 2.0 * m1,
        da1_da: -2.0 * cos_w - 2.0,
        da1_dcos: -2.0 * p1,

        a2: cos_w * m1 - k + p1,
        da2_da: -dk_da + cos_w + 1.0,
        da2_dalpha: -dk_dalpha,
        da2_dcos: m1,
    }
}

pub(super) fn hsc(a_val: f32, cos_w: f32, alpha: f32) -> Biquad {
    let p1 = a_val + 1.0;
    let m1 = a_val - 1.0;
    let sqrt_a = a_val.sqrt();
    let k = 2.0 * sqrt_a * alpha;
    let dk_da = alpha / sqrt_a;
    let dk_dalpha = 2.0 * sqrt_a;

    Biquad {
        b0: a_val * (cos_w * m1 + k + p1),
        db0_da: a_val * dk_da + a_val * cos_w + a_val + cos_w * m1 + k + p1,
        db0_dalpha: a_val * dk_dalpha,
        db0_dcos: a_val * m1,

        b1: -2.0 * a_val * (cos_w * p1 + m1),
        db1_da: -2.0 * a_val * cos_w - 2.0 * a_val - 2.0 * cos_w * p1 - 2.0 * m1,
        db1_dcos: -2.0 * a_val * p1,

        b2: a_val * (cos_w * m1 - k + p1),
        db2_da: -a_val * dk_da + a_val * cos_w + a_val + cos_w * m1 - k + p1,
        db2_dalpha: -a_val * dk_dalpha,
        db2_dcos: a_val * m1,

        a0: -cos_w * m1 + k + p1,
        da0_da: dk_da - cos_w + 1.0,
        da0_dalpha: dk_dalpha,
        da0_dcos: -m1,

        a1: -2.0 * cos_w * p1 + 2.0 * m1,
        da1_da: 2.0 - 2.0 * cos_w,
        da1_dcos: -2.0 * p1,

        a2: -cos_w * m1 - k + p1,
        da2_da: -dk_da - cos_w + 1.0,
        da2_dalpha: -dk_dalpha,
        da2_dcos: -m1,
    }
}

pub(super) fn q_to_bw(q: f32) -> f32 {
    (2.0 / std::f32::consts::LN_2) * (0.5 / q).asinh()
}

pub(super) fn bw_to_q(bw: f32) -> f32 {
    0.5 / (0.5 * std::f32::consts::LN_2 * bw).sinh()
}

pub(super) fn sq(x: f32) -> f32 {
    x * x
}

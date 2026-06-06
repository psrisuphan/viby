import { type PeqBand } from '../stores/settingsStore';
import { type TargetCurve } from './tauri';

const K = 384;
const fs = 48000;
const F_MIN = 20;
const F_MAX = 20000;
const L_MIN = Math.log(F_MIN);
const L_MAX = Math.log(F_MAX);
const LR = L_MAX - L_MIN;

// 1. Generate K=384 log-spaced frequency sampling points
const freqs = new Float32Array(K);
for (let k = 0; k < K; k++) {
  freqs[k] = Math.exp(L_MIN + (LR * k) / (K - 1));
}

// 2. Precompute phi vector for transfer function magnitude evaluation
const phi = new Float32Array(K);
for (let k = 0; k < K; k++) {
  phi[k] = Math.pow(Math.sin((Math.PI / fs) * freqs[k]), 2);
}

interface Biquad {
  b0: number; db0_dA: number; db0_dalpha: number; db0_dcos: number;
  b1: number; db1_dA: number; db1_dcos: number;
  b2: number; db2_dA: number; db2_dalpha: number; db2_dcos: number;
  a0: number; da0_dA: number; da0_dalpha: number; da0_dcos: number;
  a1: number; da1_dA: number; da1_dcos: number;
  a2: number; da2_dA: number; da2_dalpha: number; da2_dcos: number;
}

// ── Biquad Coefficient functions with Analytical Derivatives ──

function pk(A: number, cos_w: number, alpha: number): Biquad {
  const rA = 1.0 / A;
  return {
    b0: A * alpha + 1.0,
    db0_dA: alpha,
    db0_dalpha: A,
    db0_dcos: 0.0,

    b1: -2.0 * cos_w,
    db1_dA: 0.0,
    db1_dcos: -2.0,

    b2: -A * alpha + 1.0,
    db2_dA: -alpha,
    db2_dalpha: -A,
    db2_dcos: 0.0,

    a0: (A + alpha) * rA,
    da0_dA: -alpha * rA * rA,
    da0_dalpha: rA,
    da0_dcos: 0.0,

    a1: -2.0 * cos_w,
    da1_dA: 0.0,
    da1_dcos: -2.0,

    a2: (A - alpha) * rA,
    da2_dA: alpha * rA * rA,
    da2_dalpha: -rA,
    da2_dcos: 0.0,
  };
}

function lsc(A: number, cos_w: number, alpha: number): Biquad {
  const p1 = A + 1.0;
  const m1 = A - 1.0;
  const sqrt_A = Math.sqrt(A);
  const k = 2.0 * sqrt_A * alpha;
  const dk_dA = alpha / sqrt_A;
  const dk_dalpha = 2.0 * sqrt_A;

  return {
    b0: A * (-cos_w * m1 + k + p1),
    db0_dA: A * dk_dA - A * cos_w + A - cos_w * m1 + k + p1,
    db0_dalpha: A * dk_dalpha,
    db0_dcos: -A * m1,

    b1: 2.0 * A * (-cos_w * p1 + m1),
    db1_dA: -2.0 * A * cos_w + 2.0 * A - 2.0 * cos_w * p1 + 2.0 * m1,
    db1_dcos: -2.0 * A * p1,

    b2: A * (-cos_w * m1 - k + p1),
    db2_dA: -A * dk_dA - A * cos_w + A - cos_w * m1 - k + p1,
    db2_dalpha: -A * dk_dalpha,
    db2_dcos: -A * m1,

    a0: cos_w * m1 + k + p1,
    da0_dA: dk_dA + cos_w + 1.0,
    da0_dalpha: dk_dalpha,
    da0_dcos: m1,

    a1: -2.0 * cos_w * p1 - 2.0 * m1,
    da1_dA: -2.0 * cos_w - 2.0,
    da1_dcos: -2.0 * p1,

    a2: cos_w * m1 - k + p1,
    da2_dA: -dk_dA + cos_w + 1.0,
    da2_dalpha: -dk_dalpha,
    da2_dcos: m1,
  };
}

function hsc(A: number, cos_w: number, alpha: number): Biquad {
  const p1 = A + 1.0;
  const m1 = A - 1.0;
  const sqrt_A = Math.sqrt(A);
  const k = 2.0 * sqrt_A * alpha;
  const dk_dA = alpha / sqrt_A;
  const dk_dalpha = 2.0 * sqrt_A;

  return {
    b0: A * (cos_w * m1 + k + p1),
    db0_dA: A * dk_dA + A * cos_w + A + cos_w * m1 + k + p1,
    db0_dalpha: A * dk_dalpha,
    db0_dcos: A * m1,

    b1: -2.0 * A * (cos_w * p1 + m1),
    db1_dA: -2.0 * A * cos_w - 2.0 * A - 2.0 * cos_w * p1 - 2.0 * m1,
    db1_dcos: -2.0 * A * p1,

    b2: A * (cos_w * m1 - k + p1),
    db2_dA: -A * dk_dA + A * cos_w + A + cos_w * m1 - k + p1,
    db2_dalpha: -A * dk_dalpha,
    db2_dcos: A * m1,

    a0: -cos_w * m1 + k + p1,
    da0_dA: dk_dA - cos_w + 1.0,
    da0_dalpha: dk_dalpha,
    da0_dcos: -m1,

    a1: -2.0 * cos_w * p1 + 2.0 * m1,
    da1_dA: 2.0 - 2.0 * cos_w,
    da1_dcos: -2.0 * p1,

    a2: -cos_w * m1 - k + p1,
    da2_dA: -dk_dA - cos_w + 1.0,
    da2_dalpha: -dk_dalpha,
    da2_dcos: -m1,
  };
}

const BIQUAD_FNS = [pk, lsc, hsc];

function q_to_bw(Q: number): number {
  return (2.0 / Math.LN2) * Math.asinh(0.5 / Q);
}

function bw_to_q(bw: number): number {
  return 0.5 / Math.sinh(0.5 * Math.LN2 * bw);
}

function sq(x: number): number {
  return x * x;
}

// ── Gradient & Loss Evaluator ──

function grad(
  N: number,
  types: number[],
  x: Float32Array,
  g: Float32Array,
  r: Float32Array,
  optAmp: boolean
): number {
  const rK = 1.0 / K;

  const dy_dw0 = Array.from({ length: N }, () => new Float32Array(K));
  const dy_dgain = Array.from({ length: N }, () => new Float32Array(K));
  const dy_dbw = Array.from({ length: N }, () => new Float32Array(K));
  const w0_v = new Float32Array(N);

  const pred = new Float32Array(K);
  const AMP = 3 * N;
  const pred_init = optAmp ? Math.pow(10, x[AMP] / 10.0) : 1.0;
  pred.fill(pred_init);

  for (let n = 0; n < N; n++) {
    const f0 = Math.exp(x[n]); // LF_AT
    const gain = x[N + n];     // GAIN_AT
    const bw = x[2 * N + n];   // BW_AT

    const A = Math.pow(10, gain / 40.0);
    const w0 = (2.0 * Math.PI / fs) * f0;
    const cos_w = Math.cos(w0);
    const sin_w = Math.sin(w0);
    const kQ = Math.sinh(0.5 * Math.LN2 * bw);
    const alpha = sin_w * kQ;

    w0_v[n] = w0;

    const biquadFn = BIQUAD_FNS[types[n]];
    const s = biquadFn(A, cos_w, alpha);

    const dA_dgain = A * Math.LN10 / 40.0;
    const dalpha_dw0 = cos_w * kQ;
    const dalpha_dbw = sin_w * Math.cosh(0.5 * Math.LN2 * bw) * 0.5 * Math.LN2;
    const dcos_dw0 = -sin_w;

    const b_x0 = sq(s.b0 + s.b1 + s.b2);
    const b_x1 = -4.0 * (s.b0 * s.b1 + 4.0 * s.b0 * s.b2 + s.b1 * s.b2);
    const b_x2 = 16.0 * s.b0 * s.b2;
    
    const a_x0 = sq(s.a0 + s.a1 + s.a2);
    const a_x1 = -4.0 * (s.a0 * s.a1 + 4.0 * s.a0 * s.a2 + s.a1 * s.a2);
    const a_x2 = 16.0 * s.a0 * s.a2;

    const ba = s.b0 + s.b1 + s.b2;
    const aa = s.a0 + s.a1 + s.a2;

    for (let k = 0; k < K; k++) {
      const phi_k = phi[k];

      const b_poly = b_x0 + phi_k * (b_x1 + phi_k * b_x2);
      const a_poly = a_x0 + phi_k * (a_x1 + phi_k * a_x2);

      pred[k] *= b_poly / a_poly;

      // backward
      const _8phi2 = 8.0 * phi_k * phi_k;
      const _2phi = 2.0 * phi_k;

      const bm = (20.0 / Math.LN10) / b_poly;
      const am = (-20.0 / Math.LN10) / a_poly;

      const dy_db0 = bm * (ba - _2phi * (s.b1 + 4.0 * s.b2) + _8phi2 * s.b2);
      const dy_db1 = bm * (ba - _2phi * (s.b0 + s.b2));
      const dy_db2 = bm * (ba - _2phi * (4.0 * s.b0 + s.b1) + _8phi2 * s.b0);

      const dy_da0 = am * (aa - _2phi * (s.a1 + 4.0 * s.a2) + _8phi2 * s.a2);
      const dy_da1 = am * (aa - _2phi * (s.a0 + s.a2));
      const dy_da2 = am * (aa - _2phi * (4.0 * s.a0 + s.a1) + _8phi2 * s.a0);

      const dy_dA =
        dy_db0 * s.db0_dA +
        dy_db1 * s.db1_dA +
        dy_db2 * s.db2_dA +
        dy_da0 * s.da0_dA +
        dy_da1 * s.da1_dA +
        dy_da2 * s.da2_dA;

      const dy_dalpha =
        dy_db0 * s.db0_dalpha +
        dy_db2 * s.db2_dalpha +
        dy_da0 * s.da0_dalpha +
        dy_da2 * s.da2_dalpha;

      const dy_dcos =
        dy_db0 * s.db0_dcos +
        dy_db1 * s.db1_dcos +
        dy_db2 * s.db2_dcos +
        dy_da0 * s.da0_dcos +
        dy_da1 * s.da1_dcos +
        dy_da2 * s.da2_dcos;

      dy_dw0[n][k] = dy_dalpha * dalpha_dw0 + dy_dcos * dcos_dw0;
      dy_dgain[n][k] = dy_dA * dA_dgain;
      dy_dbw[n][k] = dy_dalpha * dalpha_dbw;
    }
  }

  let L = 0;
  const dL_dy = new Float32Array(K);
  let dL_dy_sum = 0;

  for (let k = 0; k < K; k++) {
    const d = 10.0 * Math.log10(pred[k]) - r[k];
    L += d * d;
    dL_dy[k] = 2.0 * d;
    dL_dy_sum += dL_dy[k];
  }

  L *= rK;
  g[AMP] = optAmp ? dL_dy_sum * rK : 0.0;

  for (let n = 0; n < N; n++) {
    let glf = 0;
    let ggain = 0;
    let gbw = 0;

    for (let k = 0; k < K; k++) {
      glf += dL_dy[k] * dy_dw0[n][k];
      ggain += dL_dy[k] * dy_dgain[n][k];
      gbw += dL_dy[k] * dy_dbw[n][k];
    }

    g[n] = glf * rK * w0_v[n];             // LF(n)
    g[N + n] = ggain * rK;                 // GAIN(n)
    g[2 * N + n] = gbw * rK;               // BW(n)
  }

  return L;
}

// ── AdaBelief Optimizer ──

class AdaBelief {
  m: Float32Array;
  s: Float32Array;
  b1 = 0.9;
  b2 = 0.99;
  b1t = 0.9;
  b2t = 0.99;
  eps = 1e-12;
  eps_root = 1e-12;
  lr = 4e-2;
  size: number;

  constructor(size: number) {
    this.size = size;
    this.m = new Float32Array(size);
    this.s = new Float32Array(size);
  }

  step(x: Float32Array, g: Float32Array) {
    for (let w = 0; w < this.size; w++) {
      this.m[w] = this.b1 * this.m[w] + (1.0 - this.b1) * g[w];
      this.s[w] = this.b2 * this.s[w] + (1.0 - this.b2) * sq(g[w] - this.m[w]);

      const m_hat = this.m[w] / (1.0 - this.b1t);
      const s_hat = this.s[w] / (1.0 - this.b2t);

      const den = Math.sqrt(s_hat + this.eps_root) + this.eps;
      x[w] -= this.lr * m_hat / den;
    }

    this.b1t *= this.b1;
    this.b2t *= this.b2;
  }
}

// ── Preprocessing & Bilateral Adaptive Smoothing ──

interface SmoothConfig {
  smooth_lo: number;
  smooth_hi: number;
  smooth_f0: number;
  smooth_f1: number;
  bias_lo: number;
  bias_md: number;
  bias_hi: number;
  bias_f0: number;
  bias_f1: number;
  bias_f2: number;
  bias_f3: number;
  clip_f: number;
}

const IE_SMOOTH: SmoothConfig = {
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

const OE_SMOOTH: SmoothConfig = {
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

function sgm(x: number, x0: number, x1: number): number {
  const SMOOTH = 4.0;
  const k = SMOOTH / (x1 - x0);
  const m = 0.5 * (x0 + x1);
  const y = k * (x - m);
  return 0.5 * Math.tanh(0.5 * y) + 0.5;
}

function search(x: Float32Array, v: number): number {
  let idx = -1;
  let best = 1e9;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - v);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

function adaptive_smooth(s: SmoothConfig, f: Float32Array, r: Float32Array) {
  const H = 48;
  const smooth_l0 = Math.log(s.smooth_f0);
  const smooth_l1 = Math.log(s.smooth_f1);
  const bias_l0 = Math.log(s.bias_f0);
  const bias_l1 = Math.log(s.bias_f1);
  const bias_l2 = Math.log(s.bias_f2);
  const bias_l3 = Math.log(s.bias_f3);

  const x = new Float32Array(r);
  const clip_idx = search(f, s.clip_f);

  for (let k = 0; k < K; k++) {
    const f_k = f[k];
    const l = Math.log(f_k);
    const x_k = x[k];

    const sigma = s.smooth_lo + (s.smooth_hi - s.smooth_lo) * sgm(l, smooth_l0, smooth_l1);
    const bias = s.bias_lo + (s.bias_md - s.bias_lo) * sgm(l, bias_l0, bias_l1)
                           + (s.bias_hi - s.bias_md) * sgm(l, bias_l2, bias_l3);

    let a = 0;
    let c = 0;

    for (let j = -H; j <= H; j++) {
      let s_idx = k + j;
      if (s_idx < 0) s_idx = 0;
      else if (s_idx > clip_idx) s_idx = clip_idx;

      const x_s = x[s_idx];
      const d_spatial = (j * sigma) * (j * sigma);
      const d_range = bias * (x_s - x_k);

      const w = Math.exp(-0.5 * d_spatial + d_range);

      a += w * x[s_idx];
      c += w;
    }

    r[k] = a / (c || 1);
  }
}

function treble_rolloff(f: Float32Array, r: Float32Array, f_treble: number) {
  const treble_idx = search(f, f_treble);
  if (treble_idx === -1) return;
  const n_treble = K - treble_idx;
  const inv = 1.0 / (n_treble - 1 || 1);

  for (let i = 0; i < n_treble; i++) {
    const t = i * inv;
    const w = Math.cos(0.5 * Math.PI * t);
    r[treble_idx + i] *= w;
  }
}

function preprocess(
  f: Float32Array,
  dst: Float32Array,
  src: Float32Array,
  r: Float32Array,
  smooth: SmoothConfig | null,
  demean: boolean
): number {
  const F_TREBLE_SMOOTH = 16000.0;
  const F_TREBLE_UNSMOOTH = 18500.0;

  const b = new Float32Array(src);

  if (smooth) {
    adaptive_smooth(smooth, f, b);
  }

  for (let k = 0; k < K; k++) {
    r[k] = dst[k] - b[k];
  }

  let mean = 0;
  if (demean) {
    let sum = 0;
    for (let k = 0; k < K; k++) sum += r[k];
    mean = sum / K;
    for (let k = 0; k < K; k++) r[k] -= mean;
  }

  treble_rolloff(f, r, smooth ? F_TREBLE_SMOOTH : F_TREBLE_UNSMOOTH);

  return mean;
}

// ── Peak-finding greedy Initialization ──

interface Peak {
  width: number;
  height: number;
  idx: number;
}

function largestPeak(x: Float32Array, f: Float32Array, limLo: number, limHi: number): Peak {
  const peaks: number[] = [];

  // find_peaks
  for (let i = 1; i < K - 1; i++) {
    if (f[i] < limLo || f[i] > limHi) continue;
    if (x[i - 1] >= x[i]) continue;

    let i_ahead = i + 1;
    while (i_ahead < K - 1 && x[i_ahead] === x[i]) {
      i_ahead++;
    }

    if (x[i_ahead] < x[i]) {
      const left_edge = i;
      const right_edge = i_ahead - 1;
      peaks.push(Math.round((left_edge + right_edge) / 2));
      i = i_ahead;
    }
  }

  const prominences = new Float32Array(peaks.length);
  const left_bases = new Int32Array(peaks.length);
  const right_bases = new Int32Array(peaks.length);

  // peak_prominences
  for (let p = 0; p < peaks.length; p++) {
    const peak = peaks[p];
    const x_peak = x[peak];

    left_bases[p] = peak;
    let left_min = x_peak;
    for (let i = peak; i >= 0 && x[i] <= x_peak; i--) {
      if (x[i] < left_min) {
        left_min = x[i];
        left_bases[p] = i;
      }
    }

    right_bases[p] = peak;
    let right_min = x_peak;
    for (let i = peak; i < K && x[i] <= x_peak; i++) {
      if (x[i] < right_min) {
        right_min = x[i];
        right_bases[p] = i;
      }
    }

    prominences[p] = x_peak - Math.max(left_min, right_min);
  }

  // peak_widths
  let largest: Peak = { idx: -1, width: 0, height: 0 };
  let largest_size = 0;

  for (let p = 0; p < peaks.length; p++) {
    const i_min = left_bases[p];
    const i_max = right_bases[p];
    const peak = peaks[p];

    const x_peak = x[peak];
    const height = x_peak - 0.5 * prominences[p];

    let i = peak;
    while (i_min < i && height < x[i]) i--;

    let left_ip = i;
    if (x[i] < height && i + 1 < K) {
      left_ip += (height - x[i]) / (x[i + 1] - x[i]);
    }

    i = peak;
    while (i < i_max && height < x[i]) i++;

    let right_ip = i;
    if (x[i] < height && i - 1 >= 0) {
      right_ip -= (height - x[i]) / (x[i - 1] - x[i]);
    }

    const width = right_ip - left_ip;
    const size = width * x_peak;

    if (size > largest_size) {
      largest = { idx: peak, width, height: x_peak };
      largest_size = size;
    }
  }

  return largest;
}

interface FilterParams {
  f0: number;
  gain: number;
  Q: number;
}

function init_pk(
  y: Float32Array,
  f: Float32Array,
  lim_f0: { lo: number; hi: number },
  lim_gain: { lo: number; hi: number },
  lim_q: { lo: number; hi: number }
): FilterParams {
  const rectPeak = new Float32Array(K);
  const rectDip = new Float32Array(K);

  for (let k = 0; k < K; k++) {
    rectPeak[k] = Math.max(y[k], 0);
    rectDip[k] = Math.max(-y[k], 0);
  }

  const peak = largestPeak(rectPeak, f, lim_f0.lo, lim_f0.hi);
  const dip = largestPeak(rectDip, f, lim_f0.lo, lim_f0.hi);

  const p = peak.width * peak.height > dip.width * dip.height ? peak : dip;

  if (p.idx === -1) {
    return { f0: 1000, gain: 0, Q: 1.0 };
  }

  const f0 = f[p.idx];
  let gain = p.idx === peak.idx ? peak.height : -dip.height;
  const bw = p.width * Math.log2(f[1] / f[0]);
  const bw_exp2 = Math.pow(2, bw);
  let Q = Math.sqrt(bw_exp2) / (bw_exp2 - 1.0);

  gain = Math.max(lim_gain.lo, Math.min(lim_gain.hi, gain));
  Q = Math.max(lim_q.lo, Math.min(lim_q.hi, Q));
  if (isNaN(Q) || !isFinite(Q)) Q = 1.0;

  return { f0, gain, Q };
}

function init_lsc(
  y: Float32Array,
  f: Float32Array,
  lim_f0: { lo: number; hi: number },
  lim_gain: { lo: number; hi: number },
  lim_q: { lo: number; hi: number }
): FilterParams {
  const lo = Math.max(lim_f0.lo, 40);
  const hi = Math.min(lim_f0.hi, 10000);

  let best = 0;
  let best_idx = -1;

  let sum = 0;
  for (let k = 0; k < K; k++) {
    sum += y[k];
    const avg = Math.abs(sum / (k + 1));
    if (avg > best) {
      best = avg;
      best_idx = k;
    }
  }

  if (best_idx === -1) best_idx = 0;
  let f0 = f[best_idx];
  let Q = Math.SQRT1_2;

  f0 = Math.max(lo, Math.min(hi, f0));
  Q = Math.max(lim_q.lo, Math.min(lim_q.hi, Q));

  const w = new Float32Array(K);
  spectrum(1, f0, 1.0, Q, fs, f, w);

  let p = 0;
  let c = 0;
  for (let k = 0; k < K; k++) {
    p += w[k] * y[k];
    c += w[k];
  }

  let gain = p / (c || 1);
  gain = Math.max(lim_gain.lo, Math.min(lim_gain.hi, gain));

  return { f0, gain, Q };
}

function init_hsc(
  y: Float32Array,
  f: Float32Array,
  lim_f0: { lo: number; hi: number },
  lim_gain: { lo: number; hi: number },
  lim_q: { lo: number; hi: number }
): FilterParams {
  const lo = Math.max(lim_f0.lo, 40);
  const hi = Math.min(lim_f0.hi, 10000);

  let best = 0;
  let best_idx = -1;

  let sum = 0;
  for (let k = 0; k < K; k++) {
    sum += y[K - 1 - k];
    const avg = Math.abs(sum / (k + 1));
    if (avg > best) {
      best = avg;
      best_idx = K - 1 - k;
    }
  }

  if (best_idx === -1) best_idx = K - 1;
  let f0 = f[best_idx];
  let Q = Math.SQRT1_2;

  f0 = Math.max(lo, Math.min(hi, f0));
  Q = Math.max(lim_q.lo, Math.min(lim_q.hi, Q));

  const w = new Float32Array(K);
  spectrum(2, f0, 1.0, Q, fs, f, w);

  let p = 0;
  let c = 0;
  for (let k = 0; k < K; k++) {
    p += w[k] * y[k];
    c += w[k];
  }

  let gain = p / (c || 1);
  gain = Math.max(lim_gain.lo, Math.min(lim_gain.hi, gain));

  return { f0, gain, Q };
}

const INIT_FNS = [init_pk, init_lsc, init_hsc];

function spectrum(type: number, f0: number, gain: number, Q: number, fs: number, f: Float32Array, y: Float32Array) {
  const A = Math.pow(10, gain / 40.0);
  const w0 = (2.0 * Math.PI / fs) * f0;
  const cos_w = Math.cos(w0);
  const sin_w = Math.sin(w0);
  const alpha = sin_w * 0.5 / Q;

  const biquadFn = BIQUAD_FNS[type];
  const s = biquadFn(A, cos_w, alpha);

  const b_x0 = sq(s.b0 + s.b1 + s.b2);
  const b_x1 = -4.0 * (s.b0 * s.b1 + 4.0 * s.b0 * s.b2 + s.b1 * s.b2);
  const b_x2 = 16.0 * s.b0 * s.b2;
  const a_x0 = sq(s.a0 + s.a1 + s.a2);
  const a_x1 = -4.0 * (s.a0 * s.a1 + 4.0 * s.a0 * s.a2 + s.a1 * s.a2);
  const a_x2 = 16.0 * s.a0 * s.a2;

  for (let k = 0; k < K; k++) {
    const phi_val = Math.pow(Math.sin((Math.PI / fs) * f[k]), 2);
    const b_poly = b_x0 + phi_val * (b_x1 + phi_val * b_x2);
    const a_poly = a_x0 + phi_val * (a_x1 + phi_val * a_x2);

    y[k] += 10.0 * Math.log10(b_poly / a_poly);
  }
}

// ── Global Fit projection optimizer ──

function fit(
  steps: number,
  N: number,
  types: number[],
  f0: Float32Array,
  gain: Float32Array,
  Q: Float32Array,
  amp: { val: number } | null,
  r: Float32Array
): number {
  const lf_lim = Array.from({ length: N }, () => ({
    lo: Math.log(20),
    hi: Math.log(20000)
  }));
  const gain_lim = Array.from({ length: N }, () => ({
    lo: -12,
    hi: 12
  }));
  const bw_lim = Array.from({ length: N }, () => ({
    lo: q_to_bw(10.0),
    hi: q_to_bw(0.1)
  }));

  const x = new Float32Array(3 * N + 1);
  for (let n = 0; n < N; n++) {
    x[n] = Math.log(f0[n]);
    x[N + n] = gain[n];
    x[2 * N + n] = q_to_bw(Q[n]);
  }
  const AMP = 3 * N;
  x[AMP] = amp ? amp.val : 0.0;

  const g = new Float32Array(3 * N + 1);
  const best = new Float32Array(3 * N + 1);
  let best_L = 1e9;

  const opt = new AdaBelief(3 * N + 1);

  function limit_param(val: number, lo: number, hi: number): { val: number; clamped: boolean } {
    if (val < lo) return { val: lo, clamped: true };
    if (val > hi) return { val: hi, clamped: true };
    return { val, clamped: false };
  }

  for (let step = 0; step < steps; step++) {
    const L = grad(N, types, x, g, r, !!amp);

    opt.step(x, g);

    // Box constraints via projection
    for (let n = 0; n < N; n++) {
      const lfRes = limit_param(x[n], lf_lim[n].lo, lf_lim[n].hi);
      x[n] = lfRes.val;
      if (lfRes.clamped) opt.m[n] = 0;

      const gainRes = limit_param(x[N + n], gain_lim[n].lo, gain_lim[n].hi);
      x[N + n] = gainRes.val;
      if (gainRes.clamped) opt.m[N + n] = 0;

      const bwLo = Math.min(bw_lim[n].lo, bw_lim[n].hi);
      const bwHi = Math.max(bw_lim[n].lo, bw_lim[n].hi);
      const bwRes = limit_param(x[2 * N + n], bwLo, bwHi);
      x[2 * N + n] = bwRes.val;
      if (bwRes.clamped) opt.m[2 * N + n] = 0;
    }

    if (L < best_L) {
      best_L = L;
      best.set(x);
    }
  }

  for (let n = 0; n < N; n++) {
    f0[n] = Math.exp(best[n]);
    gain[n] = best[N + n];
    Q[n] = bw_to_q(best[2 * N + n]);
  }

  if (amp) {
    amp.val = best[AMP];
  }

  return best_L;
}

// ── Main Run function ──

export function runAutoEq(
  measurement: TargetCurve,
  target: TargetCurve,
  bandsToOptimize: PeqBand[]
): { bands: PeqBand[]; preamp: number } {
  const N = bandsToOptimize.length;
  if (N === 0) return { bands: [], preamp: 0 };

  // Parse types of bands (0=PK, 1=LSC, 2=HSC). Limit to PK, LSC, HSC.
  const types = bandsToOptimize.map(b => {
    if (b.filterType === 1 || b.filterType === 2) return b.filterType;
    return 0; // default Peaking
  });

  // Precompute target and measurement interpolated points at log-spaced frequencies
  const sortedTargetPoints = [...target.points].sort((a, b) => a[0] - b[0]);
  const sortedMeasPoints = [...measurement.points].sort((a, b) => a[0] - b[0]);

  function interpolatePoint(points: [number, number][], freq: number): number {
    if (points.length === 0) return 0;
    if (freq <= points[0][0]) return points[0][1];
    if (freq >= points[points.length - 1][0]) return points[points.length - 1][1];

    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid][0] === freq) return points[mid][1];
      if (points[mid][0] < freq) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const p0 = points[low - 1];
    const p1 = points[low];
    if (!p0 || !p1) return 0;
    const t = (freq - p0[0]) / (p1[0] - p0[0]);
    return p0[1] + t * (p1[1] - p0[1]);
  }

  const dst = new Float32Array(K);
  const src = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    dst[k] = interpolatePoint(sortedTargetPoints, freqs[k]);
    src[k] = interpolatePoint(sortedMeasPoints, freqs[k]);
  }

  // Preprocessing (demean and rolling-off treble)
  const r = new Float32Array(K);
  const targetNameNorm = target.name.toLowerCase();
  const smooth = targetNameNorm.includes('ie') ? IE_SMOOTH : OE_SMOOTH;
  preprocess(freqs, dst, src, r, smooth, true);

  // Initialize filters greedily using peak finding
  const r_init = new Float32Array(r);
  const f0 = new Float32Array(N);
  const gain = new Float32Array(N);
  const Q = new Float32Array(N);

  const f0_lim = { lo: F_MIN, hi: F_MAX };
  const gain_lim = { lo: -12, hi: 12 };
  const Q_lim = { lo: 0.1, hi: 10.0 };

  for (let n = 0; n < N; n++) {
    const init_fn = INIT_FNS[types[n]];
    const p = init_fn(r_init, freqs, f0_lim, gain_lim, Q_lim);
    spectrum(types[n], p.f0, -p.gain, p.Q, fs, freqs, r_init);

    f0[n] = p.f0;
    gain[n] = p.gain;
    Q[n] = p.Q;
  }

  // Global Optimization using AdaBelief Gradient Descent (2000 steps)
  fit(2000, N, types, f0, gain, Q, null, r);

  // Create clean rounded PEQ bands
  const bands: PeqBand[] = Array.from({ length: N }, (_, n) => {
    return {
      enabled: true,
      filterType: types[n] as 0 | 1 | 2,
      freq: Math.max(F_MIN, Math.min(F_MAX, Math.round(f0[n]))),
      gain: Number(Math.max(-12, Math.min(12, gain[n])).toFixed(1)),
      q: Number(Math.max(0.1, Math.min(10.0, Q[n])).toFixed(2)),
    };
  });

  // Calculate pre-amp to prevent digital clipping (headroom management)
  let maxPeak = 0;
  for (let j = 0; j < K; j++) {
    let response = 0;
    for (let n = 0; n < N; n++) {
      const A = Math.pow(10, bands[n].gain / 40.0);
      const w0 = (2.0 * Math.PI / fs) * bands[n].freq;
      const cos_w = Math.cos(w0);
      const sin_w = Math.sin(w0);
      const alpha = sin_w * 0.5 / bands[n].q;

      const s = BIQUAD_FNS[types[n]](A, cos_w, alpha);

      const b_x0 = sq(s.b0 + s.b1 + s.b2);
      const b_x1 = -4.0 * (s.b0 * s.b1 + 4.0 * s.b0 * s.b2 + s.b1 * s.b2);
      const b_x2 = 16.0 * s.b0 * s.b2;
      const a_x0 = sq(s.a0 + s.a1 + s.a2);
      const a_x1 = -4.0 * (s.a0 * s.a1 + 4.0 * s.a0 * s.a2 + s.a1 * s.a2);
      const a_x2 = 16.0 * s.a0 * s.a2;

      const phi_val = Math.pow(Math.sin((Math.PI / fs) * freqs[j]), 2);
      const b_poly = b_x0 + phi_val * (b_x1 + phi_val * b_x2);
      const a_poly = a_x0 + phi_val * (a_x1 + phi_val * a_x2);

      response += 10.0 * Math.log10(b_poly / a_poly);
    }
    if (response > maxPeak) maxPeak = response;
  }

  const preamp = Number((-Math.max(0, maxPeak)).toFixed(1));

  return { bands, preamp };
}

// ── AutoEQ Filters Export File Parser ──

interface ParsedAutoEq {
  preamp: number;
  bands: PeqBand[];
}

export function parseAutoEqFilters(text: string): ParsedAutoEq {
  const lines = text.split('\n');
  let preamp = 0;
  const bands: PeqBand[] = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    if (line.toLowerCase().startsWith('preamp:')) {
      const parts = line.split(':');
      if (parts[1]) {
        const val = parseFloat(parts[1].trim());
        if (!isNaN(val)) {
          preamp = val;
        }
      }
      continue;
    }

    if (line.toLowerCase().startsWith('filter')) {
      const parts = line.split(':');
      if (!parts[1]) continue;

      const filterBody = parts[1].trim();
      const tokens = filterBody.split(/\s+/);
      
      const enabled = tokens[0]?.toUpperCase() === 'ON';
      const typeStr = tokens[1]?.toUpperCase();
      let filterType = 0;
      if (typeStr === 'LSC') filterType = 1;
      else if (typeStr === 'HSC') filterType = 2;
      else if (typeStr === 'LP') filterType = 3;
      else if (typeStr === 'HP') filterType = 4;

      const fcIndex = tokens.findIndex(t => t.toLowerCase() === 'fc');
      let freq = 1000;
      if (fcIndex !== -1 && tokens[fcIndex + 1]) {
        const val = parseInt(tokens[fcIndex + 1], 10);
        if (!isNaN(val)) freq = val;
      }

      const gainIndex = tokens.findIndex(t => t.toLowerCase() === 'gain');
      let gain = 0;
      if (gainIndex !== -1 && tokens[gainIndex + 1]) {
        const val = parseFloat(tokens[gainIndex + 1]);
        if (!isNaN(val)) gain = val;
      }

      const qIndex = tokens.findIndex(t => t.toLowerCase() === 'q');
      let q = 1.0;
      if (qIndex !== -1 && tokens[qIndex + 1]) {
        const val = parseFloat(tokens[qIndex + 1]);
        if (!isNaN(val)) q = val;
      }

      bands.push({
        enabled,
        filterType: filterType as 0 | 1 | 2 | 3 | 4,
        freq,
        gain,
        q
      });
    }
  }

  return { preamp, bands };
}

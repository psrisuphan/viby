import { peqBandCoeffs, totalResponseDb } from './eqDsp';
import { type PeqBand } from '../stores/settingsStore';
import { type TargetCurve } from './tauri';

function interpolateDb(points: [number, number][], freq: number): number {
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

/**
 * Computes optimal parametric EQ band settings to correct a headphone measurement toward a target curve.
 * Uses coordinate descent optimization.
 */
export function runAutoEq(
  measurement: TargetCurve,
  target: TargetCurve,
  bandCount: number
): { bands: PeqBand[]; preamp: number } {
  // 1. Generate N=120 log-spaced frequency sampling points
  const N = 120;
  const F_MIN = 20;
  const F_MAX = 20000;
  const freqs = Array.from({ length: N }, (_, i) => {
    return F_MIN * Math.pow(F_MAX / F_MIN, i / (N - 1));
  });

  // 2. Precompute desired compensation curve target_db - measurement_db at each point
  const sortedTargetPoints = [...target.points].sort((a, b) => a[0] - b[0]);
  const sortedMeasPoints = [...measurement.points].sort((a, b) => a[0] - b[0]);

  const desired = freqs.map(f => {
    return interpolateDb(sortedTargetPoints, f) - interpolateDb(sortedMeasPoints, f);
  });

  // 3. Initialize bands distributed logarithmically
  const bands = Array.from({ length: bandCount }, (_, i) => {
    const freq = F_MIN * Math.pow(F_MAX / F_MIN, (i + 0.5) / bandCount);
    return {
      enabled: true,
      filterType: 0 as const, // Peaking filter
      freq: Math.round(freq),
      gain: 0,
      q: 1.0,
    };
  });

  // Helper to compute the Mean Squared Error (MSE) loss
  function computeLoss(): number {
    const coeffs = bands.map(b => peqBandCoeffs(b.filterType, b.freq, b.gain, b.q));
    let mse = 0;
    for (let j = 0; j < N; j++) {
      const actual = totalResponseDb(coeffs, freqs[j], 0);
      const diff = desired[j] - actual;
      mse += diff * diff;
    }
    return mse / N;
  }

  // 4. Optimization via Coordinate Descent
  const EPOCHS = 40;
  
  // Search step sizes
  let freqFactor = 1.15;
  let gainStep = 1.5;
  let qFactor = 1.15;

  let bestLoss = computeLoss();

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (let i = 0; i < bandCount; i++) {
      const b = bands[i];

      // --- Optimize Gain ---
      const origGain = b.gain;
      for (const d of [gainStep, -gainStep]) {
        const nextGain = Math.max(-12, Math.min(12, origGain + d));
        b.gain = Number(nextGain.toFixed(2));
        const l = computeLoss();
        if (l < bestLoss) {
          bestLoss = l;
        } else {
          b.gain = origGain;
        }
      }

      // --- Optimize Frequency ---
      const origFreq = b.freq;
      for (const f of [freqFactor, 1 / freqFactor]) {
        const nextFreq = Math.max(F_MIN, Math.min(F_MAX, Math.round(origFreq * f)));
        b.freq = nextFreq;
        const l = computeLoss();
        if (l < bestLoss) {
          bestLoss = l;
        } else {
          b.freq = origFreq;
        }
      }

      // --- Optimize Q ---
      const origQ = b.q;
      for (const q of [qFactor, 1 / qFactor]) {
        const nextQ = Math.max(0.1, Math.min(10.0, origQ * q));
        b.q = Number(nextQ.toFixed(2));
        const l = computeLoss();
        if (l < bestLoss) {
          bestLoss = l;
        } else {
          b.q = origQ;
        }
      }
    }

    // Shrink search step sizes over time
    freqFactor = 1.0 + (freqFactor - 1.0) * 0.90;
    gainStep = gainStep * 0.90;
    qFactor = 1.0 + (qFactor - 1.0) * 0.90;

    // Early exit if steps become extremely small
    if (gainStep < 0.05 && (freqFactor - 1.0) < 0.005) {
      break;
    }
  }

  // Clean rounding for final user-facing configuration
  bands.forEach(b => {
    b.freq = Math.round(b.freq);
    b.gain = Number(Math.max(-12, Math.min(12, b.gain)).toFixed(1));
    b.q = Number(Math.max(0.1, Math.min(10, b.q)).toFixed(2));
  });

  // Calculate pre-amp to prevent digital clipping (headroom management)
  const finalCoeffs = bands.map(b => peqBandCoeffs(b.filterType, b.freq, b.gain, b.q));
  let maxPeak = 0;
  for (let j = 0; j < N; j++) {
    const r = totalResponseDb(finalCoeffs, freqs[j], 0);
    if (r > maxPeak) maxPeak = r;
  }

  // Preamp is negative of max peak (to ensure peak does not exceed 0 dBFS)
  const preamp = Number((-Math.max(0, maxPeak)).toFixed(1));

  return { bands, preamp };
}

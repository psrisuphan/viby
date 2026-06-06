// Biquad coefficient computation for EQ visualization.
// Mirrors the DSP math in src-tauri/src/audio/eq.rs so the graph matches
// what the audio engine actually applies.

export const GEQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

const SR = 44100; // reference sample rate for display; perceptually equivalent to 48 kHz

export interface BandCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number; // already divided by a0
}

function mk(
  b0: number, b1: number, b2: number,
  a0: number, a1: number, a2: number,
): BandCoeffs {
  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}

function peakingCoeffs(freq: number, gainDb: number, q: number): BandCoeffs | null {
  if (Math.abs(gainDb) < 0.005) return null;
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * freq / SR;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  return mk(1+alpha*A, -2*c, 1-alpha*A,  1+alpha/A, -2*c, 1-alpha/A);
}

function lowShelfCoeffs(freq: number, gainDb: number, q: number): BandCoeffs | null {
  if (Math.abs(gainDb) < 0.005) return null;
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * freq / SR;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  const t = 2 * Math.sqrt(A) * alpha;
  return mk(
    A*((A+1)-(A-1)*c+t),  2*A*((A-1)-(A+1)*c), A*((A+1)-(A-1)*c-t),
    (A+1)+(A-1)*c+t,     -2*((A-1)+(A+1)*c),   (A+1)+(A-1)*c-t,
  );
}

function highShelfCoeffs(freq: number, gainDb: number, q: number): BandCoeffs | null {
  if (Math.abs(gainDb) < 0.005) return null;
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * freq / SR;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  const t = 2 * Math.sqrt(A) * alpha;
  return mk(
    A*((A+1)+(A-1)*c+t),  -2*A*((A-1)+(A+1)*c), A*((A+1)+(A-1)*c-t),
    (A+1)-(A-1)*c+t,       2*((A-1)-(A+1)*c),   (A+1)-(A-1)*c-t,
  );
}

function lowPassCoeffs(freq: number, q: number): BandCoeffs {
  const w = 2 * Math.PI * freq / SR;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  const a0 = 1 + alpha;
  return { b0:(1-c)/2/a0, b1:(1-c)/a0, b2:(1-c)/2/a0, a1:-2*c/a0, a2:(1-alpha)/a0 };
}

function highPassCoeffs(freq: number, q: number): BandCoeffs {
  const w = 2 * Math.PI * freq / SR;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  const a0 = 1 + alpha;
  return { b0:(1+c)/2/a0, b1:-(1+c)/a0, b2:(1+c)/2/a0, a1:-2*c/a0, a2:(1-alpha)/a0 };
}

/// Returns biquad coefficients for a single GEQ band, or null if the band is flat.
export function geqBandCoeffs(index: number, gainDb: number): BandCoeffs | null {
  const freq = GEQ_FREQS[index];
  if (index === 0) return lowShelfCoeffs(freq, gainDb, 1 / Math.SQRT2);
  if (index === 9) return highShelfCoeffs(freq, gainDb, 1 / Math.SQRT2);
  return peakingCoeffs(freq, gainDb, Math.SQRT2);
}

/// Returns biquad coefficients for a single PEQ band.
/// filterType: 0=Peaking, 1=LowShelf, 2=HighShelf, 3=LowPass, 4=HighPass
export function peqBandCoeffs(
  filterType: number, freq: number, gainDb: number, q: number,
): BandCoeffs | null {
  const safeQ = Math.max(q, 0.01);
  switch (filterType) {
    case 1: return lowShelfCoeffs(freq, gainDb, safeQ);
    case 2: return highShelfCoeffs(freq, gainDb, safeQ);
    case 3: return lowPassCoeffs(freq, safeQ);
    case 4: return highPassCoeffs(freq, safeQ);
    default: return peakingCoeffs(freq, gainDb, safeQ);
  }
}

/// Total response in dB at a given frequency across all active bands + preamp.
export function totalResponseDb(
  bands: (BandCoeffs | null)[],
  freqHz: number,
  preampDb: number,
): number {
  const wf = 2 * Math.PI * freqHz / SR;
  const cos1 = Math.cos(wf), cos2 = Math.cos(2 * wf);
  const sin1 = Math.sin(wf), sin2 = Math.sin(2 * wf);
  let db = preampDb;
  for (const band of bands) {
    if (!band) continue;
    const nr = band.b0 + band.b1*cos1 + band.b2*cos2;
    const ni = -(band.b1*sin1 + band.b2*sin2);
    const dr = 1 + band.a1*cos1 + band.a2*cos2;
    const di = -(band.a1*sin1 + band.a2*sin2);
    const mag2 = (nr*nr + ni*ni) / Math.max(dr*dr + di*di, 1e-30);
    db += 10 * Math.log10(Math.max(mag2, 1e-30));
  }
  return db;
}

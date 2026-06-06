import { useEffect, useRef } from 'react';
import { type PeqBand } from '../../stores/settingsStore';
import { geqBandCoeffs, peqBandCoeffs, totalResponseDb, GEQ_FREQS, type BandCoeffs } from '../../utils/eqDsp';
import './EqGraph.css';

// ── Graph constants ────────────────────────────────────────────────────────
const N = 360;              // sample points along log-freq axis
const F_LO = 20, F_HI = 20000;
const LOG_LO = Math.log10(F_LO), LOG_HI = Math.log10(F_HI);
const DB_RANGE = 15;        // ± dB displayed; controls go ±12, 3 dB headroom

const PAD = { l: 30, r: 10, t: 10, b: 22 };

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS: [number, string][] = [
  [20,'20'], [100,'100'], [500,'500'], [1000,'1k'], [5000,'5k'], [20000,'20k'],
];
const DB_TICKS    = [-12, -6, 0, 6, 12];

// Convert log-freq → canvas X and dB → canvas Y within the plot area.
function fToX(f: number, plotW: number) {
  return PAD.l + ((Math.log10(f) - LOG_LO) / (LOG_HI - LOG_LO)) * plotW;
}
function dbToY(db: number, plotH: number) {
  const clamped = Math.max(-DB_RANGE, Math.min(DB_RANGE, db));
  return PAD.t + (1 - (clamped + DB_RANGE) / (2 * DB_RANGE)) * plotH;
}

export interface TargetCurve {
  name: string;
  points: [number, number][];
}

export function getTargetColor(name: string): { color: string; glowClass: string } {
  const norm = name.toLowerCase();
  if (norm.includes('ie 2019') || norm.includes('harman ie')) {
    return { color: 'hsl(280, 60%, 55%)', glowClass: 'tg-glow-purple' };
  }
  if (norm.includes('preference 2025') || norm.includes('ief')) {
    return { color: 'hsl(55, 65%, 50%)', glowClass: 'tg-glow-yellow' };
  }
  if (norm.includes('oe 2018') || norm.includes('harman oe')) {
    return { color: 'hsl(195, 75%, 50%)', glowClass: 'tg-glow-cyan' };
  }
  if (norm.includes('diamond') || norm.includes('peqdb')) {
    return { color: 'hsl(340, 75%, 55%)', glowClass: 'tg-glow-rose' };
  }
  return { color: 'hsl(145, 60%, 50%)', glowClass: 'tg-glow-green' };
}

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

// ── Props ──────────────────────────────────────────────────────────────────
type EqGraphProps =
  | { mode: 'graphic';    enabled: boolean; preamp: number; gains: number[]; targetCurves?: TargetCurve[] }
  | { mode: 'parametric'; enabled: boolean; preamp: number; bands: PeqBand[]; targetCurves?: TargetCurve[]; measurementCurves?: TargetCurve[] };

// ── Drawing ────────────────────────────────────────────────────────────────
function draw(canvas: HTMLCanvasElement, props: EqGraphProps) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  if (W === 0 || H === 0) return;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const zeroY = dbToY(0, plotH);

  // Read accent color from CSS variable.
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || 'hsl(125,75%,70%)';

  // ── Background ──────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Grid lines (horizontal = dB, vertical = freq) ───────────────────────
  ctx.lineWidth = 1;
  DB_TICKS.forEach(db => {
    const y = dbToY(db, plotH);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(W - PAD.r, y);
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.055)';
    ctx.stroke();
  });

  FREQ_TICKS.forEach(f => {
    const x = fToX(f, plotW);
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, H - PAD.b);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.stroke();
  });

  // ── Labels ───────────────────────────────────────────────────────────────
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  DB_TICKS.forEach(db => {
    if (db === 0) return;
    const y = dbToY(db, plotH);
    ctx.fillText((db > 0 ? '+' : '') + db, PAD.l - 4, y);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillText('0', PAD.l - 4, zeroY);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  FREQ_LABELS.forEach(([f, label]) => {
    ctx.fillText(label, fToX(f, plotW), H - PAD.b + 5);
  });

  // ── Build band coefficients ──────────────────────────────────────────────
  let bandCoeffs: (BandCoeffs | null)[];
  let markerFreqs: number[] = [];

  if (props.mode === 'graphic') {
    bandCoeffs = props.gains.map((g, i) => geqBandCoeffs(i, g));
    markerFreqs = [...GEQ_FREQS];
  } else {
    bandCoeffs = props.bands.map(b =>
      b.enabled ? peqBandCoeffs(b.filterType, b.freq, b.gain, b.q) : null
    );
    markerFreqs = props.bands.filter(b => b.enabled).map(b => b.freq);
  }

  const preampDb = props.enabled ? props.preamp : 0;

  // ── Sample the response curve ────────────────────────────────────────────
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < N; i++) {
    const f = Math.pow(10, LOG_LO + (i / (N - 1)) * (LOG_HI - LOG_LO));
    const db = props.enabled
      ? totalResponseDb(bandCoeffs, f, preampDb)
      : 0;
    pts.push({ x: fToX(f, plotW), y: dbToY(db, plotH) });
  }

  // ── Filled area between curve and 0 dB line ──────────────────────────────
  // Two separate gradient fills: boost region (above 0) and cut region (below 0).
  const fillAbove = ctx.createLinearGradient(0, PAD.t, 0, zeroY);
  fillAbove.addColorStop(0,   'rgba(106,211,120,0.22)');
  fillAbove.addColorStop(1,   'rgba(106,211,120,0.02)');

  const fillBelow = ctx.createLinearGradient(0, zeroY, 0, H - PAD.b);
  fillBelow.addColorStop(0,   'rgba(106,211,120,0.02)');
  fillBelow.addColorStop(1,   'rgba(106,211,120,0.12)');

  // Draw the closed path (curve + baseline) and fill with both gradients.
  // Using two semi-transparent fills with different gradients gives a nice dual-tone look.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[pts.length - 1].x, zeroY);
  ctx.lineTo(pts[0].x, zeroY);
  ctx.closePath();
  ctx.fillStyle = fillAbove;
  ctx.fill();
  ctx.fillStyle = fillBelow;
  ctx.fill();
  ctx.restore();

  // ── Curve line ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);

  ctx.lineWidth = 1.75;
  ctx.strokeStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 7;
  ctx.stroke();
  // Second pass without shadow for crisp top edge.
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.stroke();
  ctx.restore();

  // ── Band markers ──────────────────────────────────────────────────────────
  // GEQ: solid dots at each center frequency. PEQ: small diamonds.
  const isDotted = props.mode === 'parametric';
  ctx.save();
  markerFreqs.forEach(freq => {
    if (freq < F_LO || freq > F_HI) return;
    const x = fToX(freq, plotW);
    const db = props.enabled ? totalResponseDb(bandCoeffs, freq, preampDb) : 0;
    const y = dbToY(db, plotH);

    ctx.shadowColor = accent;
    ctx.shadowBlur = 6;

    if (isDotted) {
      // Diamond
      const s = 4;
      ctx.beginPath();
      ctx.moveTo(x,   y - s);
      ctx.lineTo(x+s, y);
      ctx.lineTo(x,   y + s);
      ctx.lineTo(x-s, y);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }
  });
  ctx.restore();

  // ── Target curves overlay ────────────────────────────────────────────────
  if (props.targetCurves && props.targetCurves.length > 0) {
    props.targetCurves.forEach(curve => {
      const { color } = getTargetColor(curve.name);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const f = Math.pow(10, LOG_LO + (i / (N - 1)) * (LOG_HI - LOG_LO));
        const db = interpolateDb(curve.points, f);
        const x = fToX(f, plotW);
        const y = dbToY(db, plotH);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    });
  }

  // ── Measurement curves overlay ───────────────────────────────────────────
  if (props.mode === 'parametric' && props.measurementCurves && props.measurementCurves.length > 0) {
    props.measurementCurves.forEach(curve => {
      const color = 'hsl(28, 90%, 60%)'; // Warm orange/amber for headphone measurements
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const f = Math.pow(10, LOG_LO + (i / (N - 1)) * (LOG_HI - LOG_LO));
        const db = interpolateDb(curve.points, f);
        const x = fToX(f, plotW);
        const y = dbToY(db, plotH);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    });
  }

  // ── Disabled overlay ────────────────────────────────────────────────────
  if (!props.enabled) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
  }
}

// ── Component ──────────────────────────────────────────────────────────────
export default function EqGraph(props: EqGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef  = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const redraw = () => draw(canvas, propsRef.current);
    redraw();

    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    return () => ro.disconnect();
  // Re-run the effect whenever any prop changes so the graph stays in sync.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.enabled, props.preamp, props.mode,
    props.targetCurves?.map(c => c.name).join(','),
    props.mode === 'parametric' ? props.measurementCurves?.map(c => c.name).join(',') : undefined,
    ...(props.mode === 'graphic'
      ? props.gains
      : props.bands.flatMap(b => [b.enabled ? 1 : 0, b.filterType, b.freq, b.gain, b.q])),
  ]);

  return (
    <div className="eq-graph-wrap">
      <canvas ref={canvasRef} className="eq-graph-canvas" />
    </div>
  );
}

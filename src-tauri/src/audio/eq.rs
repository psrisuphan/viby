// =============================================================================
// audio/eq.rs — 10-band graphic equalizer (biquad IIR cascade)
// =============================================================================
//
// The EQ is inserted into the rodio Source chain right after decoding:
//
//   Decoder → convert_samples::<f32> → EqSource → Sink → cpal → hardware
//
// It runs entirely in f32 floating point, so a flat EQ (all gains 0 dB) is
// bit-transparent — a peaking biquad at 0 dB is mathematically the identity.
// Boost/cut adds only f32 rounding noise (~-140 dBFS, inaudible).
//
// Parameters live in a single `EqParams` block shared via `Arc` between the
// Tauri command handlers (writers) and the audio thread (reader). We use
// atomics so the audio thread never blocks on a lock in the hot sample loop.
// A `generation` counter is bumped on every change; the audio thread only
// recomputes filter coefficients when it sees the generation advance.
// =============================================================================

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

/// Number of EQ bands.
pub const BAND_COUNT: usize = 10;

/// Center frequency for each band (octave-spaced, standard 10-band layout).
const FREQS: [f32; BAND_COUNT] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// How often (in samples) the audio thread re-checks the parameter generation.
/// 256 samples ≈ 5.3 ms at 48 kHz — imperceptible latency for a settings change.
const RECHECK_INTERVAL: u32 = 256;

/// The kind of biquad each band uses.
#[derive(Clone, Copy, PartialEq)]
enum BandType {
    LowShelf,
    Peaking,
    HighShelf,
}

/// Band type per index — the lowest/highest bands are shelves, the rest peaking.
fn band_type(index: usize) -> BandType {
    match index {
        0 => BandType::LowShelf,
        i if i == BAND_COUNT - 1 => BandType::HighShelf,
        _ => BandType::Peaking,
    }
}

// =============================================================================
// EqParams — shared, lock-free parameter block
// =============================================================================

/// Equalizer parameters shared between command handlers and the audio thread.
/// f32 values are stored as their bit pattern in `AtomicU32`.
pub struct EqParams {
    enabled: AtomicBool,
    preamp_db: AtomicU32,
    qs: [AtomicU32; BAND_COUNT],
    gains_db: [AtomicU32; BAND_COUNT],
    generation: AtomicU64,
}

/// Standard Q for an octave-spaced band (~√2). Used as the per-band default.
pub const DEFAULT_Q: f32 = 1.41;

impl EqParams {
    /// Create a flat, disabled EQ (preamp 0 dB, Q 1.41, all bands 0 dB).
    pub fn new() -> Self {
        EqParams {
            enabled: AtomicBool::new(false),
            preamp_db: AtomicU32::new(0f32.to_bits()),
            qs: std::array::from_fn(|_| AtomicU32::new(DEFAULT_Q.to_bits())),
            gains_db: std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),
            generation: AtomicU64::new(0),
        }
    }

    /// Update all parameters at once and bump the generation counter so the
    /// audio thread recomputes coefficients on its next recheck.
    pub fn set(
        &self,
        enabled: bool,
        preamp_db: f32,
        qs: [f32; BAND_COUNT],
        gains_db: [f32; BAND_COUNT],
    ) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.preamp_db.store(preamp_db.to_bits(), Ordering::Relaxed);
        for (atom, q) in self.qs.iter().zip(qs.iter()) {
            atom.store(q.clamp(0.1, 5.0).to_bits(), Ordering::Relaxed);
        }
        for (atom, g) in self.gains_db.iter().zip(gains_db.iter()) {
            atom.store(g.to_bits(), Ordering::Relaxed);
        }
        // Bump generation LAST so a reader that sees the new generation also
        // sees all the new values above.
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> EqSnapshot {
        EqSnapshot {
            enabled: self.enabled.load(Ordering::Relaxed),
            preamp_db: f32::from_bits(self.preamp_db.load(Ordering::Relaxed)),
            qs: std::array::from_fn(|i| f32::from_bits(self.qs[i].load(Ordering::Relaxed))),
            gains_db: std::array::from_fn(|i| {
                f32::from_bits(self.gains_db[i].load(Ordering::Relaxed))
            }),
        }
    }
}

impl Default for EqParams {
    fn default() -> Self {
        Self::new()
    }
}

/// A plain (non-atomic) read of the parameters, taken once per recheck.
struct EqSnapshot {
    enabled: bool,
    preamp_db: f32,
    qs: [f32; BAND_COUNT],
    gains_db: [f32; BAND_COUNT],
}

// =============================================================================
// BiquadFilter — single second-order IIR section
// =============================================================================

/// Transposed direct-form II biquad. One instance per (band × channel) so each
/// channel keeps its own filter memory.
#[derive(Clone, Copy)]
struct BiquadFilter {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl BiquadFilter {
    /// Identity filter (passes signal through unchanged).
    fn identity() -> Self {
        BiquadFilter {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Recompute coefficients (Audio EQ Cookbook, R. Bristow-Johnson).
    /// Preserves the filter state (`z1`/`z2`) so live parameter changes don't click.
    fn set_coeffs(&mut self, kind: BandType, freq: f32, gain_db: f32, q: f32, sample_rate: f32) {
        let q = q.clamp(0.1, 5.0);
        let a = 10f32.powf(gain_db / 40.0); // sqrt of linear gain
        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            BandType::Peaking => (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            ),
            BandType::LowShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                    (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                    (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
                )
            }
            BandType::HighShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                    (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                    (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
                )
            }
        };

        // Normalize by a0.
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    /// Process one sample (transposed direct form II).
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

// =============================================================================
// EqSource — rodio Source adapter that applies the EQ
// =============================================================================

/// Wraps an f32 audio source and applies the 10-band EQ + preamp per channel.
pub struct EqSource<S> {
    inner: S,
    params: Arc<EqParams>,
    channels: usize,
    sample_rate: f32,
    /// One filter bank (`BAND_COUNT` biquads) per channel.
    filters: Vec<[BiquadFilter; BAND_COUNT]>,
    current_channel: usize,
    /// Cached linear preamp factor; recomputed on each recheck.
    preamp_linear: f32,
    enabled: bool,
    last_generation: u64,
    counter: u32,
}

impl<S> EqSource<S>
where
    S: Source<Item = f32>,
{
    pub fn new(inner: S, params: Arc<EqParams>) -> Self {
        let channels = inner.channels().max(1) as usize;
        let sample_rate = inner.sample_rate() as f32;
        let filters = vec![[BiquadFilter::identity(); BAND_COUNT]; channels];

        let mut src = EqSource {
            inner,
            params,
            channels,
            sample_rate,
            filters,
            current_channel: 0,
            preamp_linear: 1.0,
            enabled: false,
            last_generation: u64::MAX, // force initial coefficient computation
            counter: 0,
        };
        src.recompute();
        src
    }

    /// Pull the latest parameters and rebuild all filter coefficients.
    fn recompute(&mut self) {
        let snap = self.params.snapshot();
        self.enabled = snap.enabled;
        self.preamp_linear = 10f32.powf(snap.preamp_db / 20.0);
        for bank in self.filters.iter_mut() {
            for (i, filter) in bank.iter_mut().enumerate() {
                filter.set_coeffs(
                    band_type(i),
                    FREQS[i],
                    snap.gains_db[i],
                    snap.qs[i],
                    self.sample_rate,
                );
            }
        }
        self.last_generation = self.params.generation();
    }
}

impl<S> Iterator for EqSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        // Periodically check whether parameters changed.
        self.counter += 1;
        if self.counter >= RECHECK_INTERVAL {
            self.counter = 0;
            if self.params.generation() != self.last_generation {
                self.recompute();
            }
        }

        if !self.enabled {
            return Some(sample);
        }

        let ch = self.current_channel;
        self.current_channel += 1;
        if self.current_channel >= self.channels {
            self.current_channel = 0;
        }

        let bank = &mut self.filters[ch];
        let mut y = sample;
        for filter in bank.iter_mut() {
            y = filter.process(y);
        }
        Some(y * self.preamp_linear)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S> Source for EqSource<S>
where
    S: Source<Item = f32>,
{
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        self.inner.current_frame_len()
    }

    #[inline]
    fn channels(&self) -> u16 {
        self.inner.channels()
    }

    #[inline]
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
}

// =============================================================================
// audio/eq.rs — 10-band graphic + 8-band parametric equalizer (biquad IIR)
// =============================================================================
//
// The EQ is inserted into the rodio Source chain right after decoding:
//
//   Decoder → convert_samples::<f32> → EqSource → Sink → cpal → hardware
//
// It supports two modes selected by `EqParams::peq_mode`:
//
//   Graphic (GEQ) — 10 fixed-frequency bands, gain-only, fixed Q per band type
//   Parametric (PEQ) — 8 fully configurable bands (freq, gain, Q, filter type)
//
// Parameters live in a single `EqParams` block shared via `Arc` between the
// Tauri command handlers (writers) and the audio thread (reader). Atomics let
// the audio thread read without locking. A `generation` counter is bumped on
// every change; the audio thread recomputes filter coefficients only when the
// generation advances.
// =============================================================================

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

/// Number of GEQ bands (fixed 10-band layout).
pub const BAND_COUNT: usize = 10;

/// Number of PEQ bands.
pub const PEQ_BAND_COUNT: usize = 8;

/// Center frequency for each GEQ band (octave-spaced, standard 10-band layout).
const FREQS: [f32; BAND_COUNT] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// How often (in samples) the audio thread re-checks the parameter generation.
const RECHECK_INTERVAL: u32 = 256;

// =============================================================================
// Filter types
// =============================================================================

#[derive(Clone, Copy, PartialEq)]
pub enum BandType {
    LowShelf,
    Peaking,
    HighShelf,
    LowPass,
    HighPass,
}

impl BandType {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => BandType::LowShelf,
            2 => BandType::HighShelf,
            3 => BandType::LowPass,
            4 => BandType::HighPass,
            _ => BandType::Peaking,
        }
    }
}

/// Band type for GEQ index — lowest/highest are shelves, rest are peaking.
fn geq_band_type(index: usize) -> BandType {
    match index {
        0 => BandType::LowShelf,
        i if i == BAND_COUNT - 1 => BandType::HighShelf,
        _ => BandType::Peaking,
    }
}

// =============================================================================
// EqParams — shared, lock-free parameter block
// =============================================================================

pub struct EqParams {
    // --- shared ---
    enabled: AtomicBool,
    preamp_db: AtomicU32,
    generation: AtomicU64,

    // --- GEQ (graphic) ---
    gains_db: [AtomicU32; BAND_COUNT],

    // --- PEQ (parametric) ---
    peq_mode: AtomicBool,
    peq_enabled: [AtomicBool; PEQ_BAND_COUNT],
    peq_types:   [AtomicU8;   PEQ_BAND_COUNT],
    peq_freqs:   [AtomicU32;  PEQ_BAND_COUNT],
    peq_gains:   [AtomicU32;  PEQ_BAND_COUNT],
    peq_qs:      [AtomicU32;  PEQ_BAND_COUNT],
}

impl EqParams {
    pub fn new() -> Self {
        EqParams {
            enabled:    AtomicBool::new(false),
            preamp_db:  AtomicU32::new(0f32.to_bits()),
            generation: AtomicU64::new(0),

            gains_db: std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),

            peq_mode:    AtomicBool::new(false),
            peq_enabled: std::array::from_fn(|_| AtomicBool::new(true)),
            peq_types:   std::array::from_fn(|_| AtomicU8::new(0)),
            peq_freqs:   std::array::from_fn(|_| AtomicU32::new(1000f32.to_bits())),
            peq_gains:   std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),
            peq_qs:      std::array::from_fn(|_| AtomicU32::new(1f32.to_bits())),
        }
    }

    /// Update GEQ parameters and switch to graphic mode.
    pub fn set(&self, enabled: bool, preamp_db: f32, gains_db: [f32; BAND_COUNT]) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.preamp_db.store(preamp_db.to_bits(), Ordering::Relaxed);
        self.peq_mode.store(false, Ordering::Relaxed);
        for (atom, g) in self.gains_db.iter().zip(gains_db.iter()) {
            atom.store(g.to_bits(), Ordering::Relaxed);
        }
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Update PEQ parameters and switch to parametric mode.
    /// `bands`: array of (band_enabled, filter_type_u8, freq_hz, gain_db, q)
    pub fn set_peq(
        &self,
        enabled: bool,
        preamp_db: f32,
        bands: [(bool, u8, f32, f32, f32); PEQ_BAND_COUNT],
    ) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.preamp_db.store(preamp_db.to_bits(), Ordering::Relaxed);
        self.peq_mode.store(true, Ordering::Relaxed);
        for (i, (ben, ty, freq, gain, q)) in bands.iter().enumerate() {
            self.peq_enabled[i].store(*ben, Ordering::Relaxed);
            self.peq_types[i].store(*ty, Ordering::Relaxed);
            self.peq_freqs[i].store(freq.to_bits(), Ordering::Relaxed);
            self.peq_gains[i].store(gain.to_bits(), Ordering::Relaxed);
            self.peq_qs[i].store(q.to_bits(), Ordering::Relaxed);
        }
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> EqSnapshot {
        EqSnapshot {
            enabled:   self.enabled.load(Ordering::Relaxed),
            preamp_db: f32::from_bits(self.preamp_db.load(Ordering::Relaxed)),
            peq_mode:  self.peq_mode.load(Ordering::Relaxed),
            gains_db: std::array::from_fn(|i| {
                f32::from_bits(self.gains_db[i].load(Ordering::Relaxed))
            }),
            peq_bands: std::array::from_fn(|i| PeqBandSnapshot {
                enabled:     self.peq_enabled[i].load(Ordering::Relaxed),
                filter_type: self.peq_types[i].load(Ordering::Relaxed),
                freq:        f32::from_bits(self.peq_freqs[i].load(Ordering::Relaxed)),
                gain:        f32::from_bits(self.peq_gains[i].load(Ordering::Relaxed)),
                q:           f32::from_bits(self.peq_qs[i].load(Ordering::Relaxed)),
            }),
        }
    }
}

impl Default for EqParams {
    fn default() -> Self {
        Self::new()
    }
}

struct PeqBandSnapshot {
    enabled:     bool,
    filter_type: u8,
    freq:        f32,
    gain:        f32,
    q:           f32,
}

struct EqSnapshot {
    enabled:   bool,
    preamp_db: f32,
    peq_mode:  bool,
    gains_db:  [f32; BAND_COUNT],
    peq_bands: [PeqBandSnapshot; PEQ_BAND_COUNT],
}

// =============================================================================
// BiquadFilter — single second-order IIR section
// =============================================================================

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
    fn identity() -> Self {
        BiquadFilter { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 }
    }

    /// Recompute coefficients (Audio EQ Cookbook, R. Bristow-Johnson).
    /// Preserves z1/z2 state so live parameter changes don't click.
    ///
    /// `q` controls bandwidth for Peaking/LP/HP, and shelf slope for shelves.
    fn set_coeffs(&mut self, kind: BandType, freq: f32, gain_db: f32, q: f32, sample_rate: f32) {
        let a = 10f32.powf(gain_db / 40.0);
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
            BandType::LowPass => (
                (1.0 - cos_w0) / 2.0,
                1.0 - cos_w0,
                (1.0 - cos_w0) / 2.0,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
            BandType::HighPass => (
                (1.0 + cos_w0) / 2.0,
                -(1.0 + cos_w0),
                (1.0 + cos_w0) / 2.0,
                1.0 + alpha,
                -2.0 * cos_w0,
                1.0 - alpha,
            ),
        };

        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

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

pub struct EqSource<S> {
    inner: S,
    params: Arc<EqParams>,
    channels: usize,
    sample_rate: f32,
    filters: Vec<[BiquadFilter; BAND_COUNT]>,
    current_channel: usize,
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
            last_generation: u64::MAX,
            counter: 0,
        };
        src.recompute();
        src
    }

    fn recompute(&mut self) {
        let snap = self.params.snapshot();
        self.enabled = snap.enabled;
        self.preamp_linear = 10f32.powf(snap.preamp_db / 20.0);

        for bank in self.filters.iter_mut() {
            if snap.peq_mode {
                // PEQ path: configure first PEQ_BAND_COUNT slots from peq_bands,
                // set remaining slots to identity.
                for (i, filter) in bank.iter_mut().enumerate() {
                    if i < PEQ_BAND_COUNT {
                        let b = &snap.peq_bands[i];
                        if b.enabled {
                            let kind = BandType::from_u8(b.filter_type);
                            let q = b.q.max(0.01);
                            filter.set_coeffs(kind, b.freq, b.gain, q, self.sample_rate);
                        } else {
                            *filter = BiquadFilter::identity();
                        }
                    } else {
                        *filter = BiquadFilter::identity();
                    }
                }
            } else {
                // GEQ path: fixed frequencies, fixed Q per band type.
                for (i, filter) in bank.iter_mut().enumerate() {
                    let kind = geq_band_type(i);
                    let q = match kind {
                        BandType::Peaking => std::f32::consts::SQRT_2,
                        _ => std::f32::consts::FRAC_1_SQRT_2,
                    };
                    filter.set_coeffs(kind, FREQS[i], snap.gains_db[i], q, self.sample_rate);
                }
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
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }

    #[inline]
    fn channels(&self) -> u16 { self.inner.channels() }

    #[inline]
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }

    #[inline]
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestSource {
        data: std::vec::IntoIter<f32>,
        sr: u32,
    }
    impl Iterator for TestSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { self.data.next() }
    }
    impl Source for TestSource {
        fn current_frame_len(&self) -> Option<usize> { None }
        fn channels(&self) -> u16 { 1 }
        fn sample_rate(&self) -> u32 { self.sr }
        fn total_duration(&self) -> Option<Duration> { None }
    }

    fn rms_at_1k(gain_db: f32, enabled: bool) -> f32 {
        let sr = 44_100u32;
        let n = sr as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * 0.5)
            .collect();

        let params = Arc::new(EqParams::new());
        let mut gains = [0f32; BAND_COUNT];
        gains[5] = gain_db;
        params.set(enabled, 0.0, gains);

        let src = TestSource { data: samples.into_iter(), sr };
        let eq = EqSource::new(src, params);

        let out: Vec<f32> = eq.skip(4096).collect();
        let sum_sq: f32 = out.iter().map(|x| x * x).sum();
        (sum_sq / out.len() as f32).sqrt()
    }

    #[test]
    fn disabled_is_transparent() {
        let r = rms_at_1k(12.0, false);
        assert!((r - 0.3536).abs() < 0.01, "expected ~0.3536, got {r}");
    }

    #[test]
    fn boost_increases_amplitude() {
        let flat = rms_at_1k(0.0, true);
        let boosted = rms_at_1k(12.0, true);
        let ratio_db = 20.0 * (boosted / flat).log10();
        assert!(ratio_db > 9.0, "expected ~+12 dB, got {ratio_db} dB");
    }

    #[test]
    fn cut_decreases_amplitude() {
        let flat = rms_at_1k(0.0, true);
        let cut = rms_at_1k(-12.0, true);
        let ratio_db = 20.0 * (cut / flat).log10();
        assert!(ratio_db < -9.0, "expected ~-12 dB, got {ratio_db} dB");
    }

    #[test]
    fn peq_flat_is_transparent() {
        let sr = 44_100u32;
        let n = sr as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * 0.5)
            .collect();

        let params = Arc::new(EqParams::new());
        let bands = std::array::from_fn(|_| (true, 0u8, 1000f32, 0f32, 1f32));
        params.set_peq(true, 0.0, bands);

        let src = TestSource { data: samples.into_iter(), sr };
        let eq = EqSource::new(src, params);

        let out: Vec<f32> = eq.skip(4096).collect();
        let sum_sq: f32 = out.iter().map(|x| x * x).sum();
        let rms = (sum_sq / out.len() as f32).sqrt();
        assert!((rms - 0.3536).abs() < 0.01, "flat PEQ not transparent: rms={rms}");
    }

    #[test]
    fn peq_boost_at_1k() {
        let sr = 44_100u32;
        let n = sr as usize;
        let make_samples = || -> Vec<f32> {
            (0..n)
                .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * 0.5)
                .collect()
        };

        let params_flat = Arc::new(EqParams::new());
        let bands_flat = std::array::from_fn(|_| (true, 0u8, 1000f32, 0f32, 1f32));
        params_flat.set_peq(true, 0.0, bands_flat);
        let flat_rms = {
            let eq = EqSource::new(TestSource { data: make_samples().into_iter(), sr }, params_flat);
            let out: Vec<f32> = eq.skip(4096).collect();
            let s: f32 = out.iter().map(|x| x * x).sum();
            (s / out.len() as f32).sqrt()
        };

        let params_boost = Arc::new(EqParams::new());
        // Band index 3: Peaking @ 1 kHz, +12 dB, Q=1
        let mut bands_boost = std::array::from_fn(|_| (true, 0u8, 1000f32, 0f32, 1f32));
        bands_boost[3] = (true, 0, 1000.0, 12.0, 1.0);
        params_boost.set_peq(true, 0.0, bands_boost);
        let boost_rms = {
            let eq = EqSource::new(TestSource { data: make_samples().into_iter(), sr }, params_boost);
            let out: Vec<f32> = eq.skip(4096).collect();
            let s: f32 = out.iter().map(|x| x * x).sum();
            (s / out.len() as f32).sqrt()
        };

        let ratio_db = 20.0 * (boost_rms / flat_rms).log10();
        assert!(ratio_db > 9.0, "PEQ +12 dB boost at 1 kHz, got {ratio_db} dB");
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    struct Sine { data: std::vec::IntoIter<f32>, sr: u32 }
    impl Iterator for Sine {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { self.data.next() }
    }
    impl Source for Sine {
        fn current_frame_len(&self) -> Option<usize> { None }
        fn channels(&self) -> u16 { 1 }
        fn sample_rate(&self) -> u32 { self.sr }
        fn total_duration(&self) -> Option<Duration> { None }
    }

    #[test]
    fn live_param_change_is_picked_up() {
        let sr = 44_100u32;
        let params = Arc::new(EqParams::new());
        params.set(true, 0.0, [0f32; BAND_COUNT]);

        let samples: Vec<f32> = (0..sr as usize * 2)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * 0.5)
            .collect();
        let mut eq = EqSource::new(Sine { data: samples.into_iter(), sr }, Arc::clone(&params));

        for _ in 0..sr as usize / 2 { eq.next(); }

        let mut gains = [0f32; BAND_COUNT];
        gains[5] = 12.0;
        params.set(true, 0.0, gains);

        for _ in 0..sr as usize / 2 { eq.next(); }
        let out: Vec<f32> = (0..sr as usize / 2).filter_map(|_| eq.next()).collect();
        let rms = (out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32).sqrt();
        assert!(rms > 1.0, "live change not applied, rms={rms}");
    }
}

// =============================================================================
// audio/eq.rs — 10-band graphic + 8-band parametric equalizer (DspEngine)
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
//
// The actual DSP processing is delegated to `DspEngine` (see dsp.rs), which
// provides TDF2 biquads (math-audio-iir-fir), SVF topology, and optional
// oversampling.
// =============================================================================

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

pub use crate::audio::dsp::{BandConfig, DspEngine, Topology};

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

    /// Map to the u8 filter-type codes used by DspEngine and the frontend.
    pub fn to_u8(self) -> u8 {
        match self {
            BandType::Peaking => 0,
            BandType::LowShelf => 1,
            BandType::HighShelf => 2,
            BandType::LowPass => 3,
            BandType::HighPass => 4,
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
    peq_types: [AtomicU8; PEQ_BAND_COUNT],
    peq_freqs: [AtomicU32; PEQ_BAND_COUNT],
    peq_gains: [AtomicU32; PEQ_BAND_COUNT],
    peq_qs: [AtomicU32; PEQ_BAND_COUNT],

    // --- Oversampling & topology (new) ---
    oversampling: AtomicU8,
    topology: AtomicU8,
}

impl EqParams {
    pub fn new() -> Self {
        EqParams {
            enabled: AtomicBool::new(false),
            preamp_db: AtomicU32::new(0f32.to_bits()),
            generation: AtomicU64::new(0),

            gains_db: std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),

            peq_mode: AtomicBool::new(false),
            peq_enabled: std::array::from_fn(|_| AtomicBool::new(true)),
            peq_types: std::array::from_fn(|_| AtomicU8::new(0)),
            peq_freqs: std::array::from_fn(|_| AtomicU32::new(1000f32.to_bits())),
            peq_gains: std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),
            peq_qs: std::array::from_fn(|_| AtomicU32::new(1f32.to_bits())),

            oversampling: AtomicU8::new(1), // 1x (off) by default
            topology: AtomicU8::new(0),     // TDF2 by default
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

    /// Set oversampling ratio (1, 2, or 4).
    pub fn set_oversampling(&self, ratio: u8) {
        let ratio = ratio.clamp(1, 4);
        self.oversampling.store(ratio, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Set topology (0=TDF2, 1=SVF).
    pub fn set_topology(&self, mode: u8) {
        let mode = if mode == 1 { 1 } else { 0 };
        self.topology.store(mode, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Get current oversampling ratio.
    pub fn get_oversampling(&self) -> u8 {
        self.oversampling.load(Ordering::Relaxed)
    }

    /// Get current topology mode.
    pub fn get_topology(&self) -> u8 {
        self.topology.load(Ordering::Relaxed)
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn snapshot(&self) -> EqSnapshot {
        EqSnapshot {
            enabled: self.enabled.load(Ordering::Relaxed),
            preamp_db: f32::from_bits(self.preamp_db.load(Ordering::Relaxed)),
            peq_mode: self.peq_mode.load(Ordering::Relaxed),
            gains_db: std::array::from_fn(|i| {
                f32::from_bits(self.gains_db[i].load(Ordering::Relaxed))
            }),
            peq_bands: std::array::from_fn(|i| PeqBandSnapshot {
                enabled: self.peq_enabled[i].load(Ordering::Relaxed),
                filter_type: self.peq_types[i].load(Ordering::Relaxed),
                freq: f32::from_bits(self.peq_freqs[i].load(Ordering::Relaxed)),
                gain: f32::from_bits(self.peq_gains[i].load(Ordering::Relaxed)),
                q: f32::from_bits(self.peq_qs[i].load(Ordering::Relaxed)),
            }),
            oversampling: self.oversampling.load(Ordering::Relaxed),
            topology: self.topology.load(Ordering::Relaxed),
        }
    }
}

impl Default for EqParams {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PeqBandSnapshot {
    pub enabled: bool,
    pub filter_type: u8,
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

pub struct EqSnapshot {
    pub enabled: bool,
    pub preamp_db: f32,
    pub peq_mode: bool,
    pub gains_db: [f32; BAND_COUNT],
    pub peq_bands: [PeqBandSnapshot; PEQ_BAND_COUNT],
    pub oversampling: u8,
    pub topology: u8,
}

// =============================================================================
// EqSource — rodio Source adapter that applies the EQ via DspEngine
// =============================================================================

pub struct EqSource<S> {
    inner: S,
    params: Arc<EqParams>,
    channels: usize,
    dsp: DspEngine,
    current_channel: usize,
    enabled: bool,
    last_generation: u64,
    counter: u32,

    // Oversampling block buffer: drains processed output from block
    // processing (only used when oversampling > 1).
    frame_out: Vec<f64>,
    frame_out_pos: usize,
    frame_out_count: usize,
}

impl<S> EqSource<S>
where
    S: Source<Item = f32>,
{
    pub fn new(inner: S, params: Arc<EqParams>) -> Self {
        let channels = inner.channels().max(1) as usize;
        let sample_rate = inner.sample_rate() as f64;

        let oversampling = params.get_oversampling();
        let topology = Topology::from_u8(params.get_topology());

        let mut src = EqSource {
            inner,
            params,
            channels,
            dsp: DspEngine::new(channels, sample_rate, oversampling, topology),
            current_channel: 0,
            enabled: false,
            last_generation: u64::MAX,
            counter: 0,
            frame_out: Vec::new(),
            frame_out_pos: 0,
            frame_out_count: 0,
        };
        src.recompute();
        src
    }

    fn recompute(&mut self) {
        let snap = self.params.snapshot();
        self.enabled = snap.enabled;
        self.dsp.set_preamp_db(snap.preamp_db as f64);

        // Sync oversampling & topology from EqParams
        self.dsp.set_oversampling(snap.oversampling);
        self.dsp.set_topology(Topology::from_u8(snap.topology));

        if snap.peq_mode {
            // PEQ path
            let bands: Vec<BandConfig> = snap
                .peq_bands
                .iter()
                .map(|b| BandConfig {
                    enabled: b.enabled,
                    filter_type: if b.enabled { b.filter_type } else { 0 },
                    freq: b.freq as f64,
                    gain_db: b.gain as f64,
                    q: b.q.max(0.01) as f64,
                })
                .collect();
            self.dsp.recompute(&bands);
        } else {
            // GEQ path
            let bands: Vec<BandConfig> = (0..BAND_COUNT)
                .map(|i| {
                    let kind = geq_band_type(i);
                    let q = match kind {
                        BandType::Peaking => std::f64::consts::SQRT_2,
                        _ => std::f64::consts::FRAC_1_SQRT_2,
                    };
                    BandConfig {
                        enabled: true,
                        filter_type: kind.to_u8(),
                        freq: FREQS[i] as f64,
                        gain_db: snap.gains_db[i] as f64,
                        q,
                    }
                })
                .collect();
            self.dsp.recompute(&bands);
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
        // Drain oversampled block output (only when oversampling > 1)
        if self.frame_out_count > 0 {
            let sample = self.frame_out[self.frame_out_pos] as f32;
            self.frame_out_pos += 1;
            self.frame_out_count -= 1;
            return Some(sample);
        }

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

        // Per-sample processing via DspEngine (zero-allocation hot path)
        let ch = self.current_channel;
        self.current_channel += 1;
        if self.current_channel >= self.channels {
            self.current_channel = 0;
        }

        let processed = self.dsp.process_sample(ch, sample as f64);
        Some(processed as f32)
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

    #[inline]
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let res = self.inner.try_seek(pos);
        if res.is_ok() {
            self.current_channel = 0;
            self.frame_out_pos = 0;
            self.frame_out_count = 0;
            self.dsp.flush_buffers();
        }
        res
    }
}

// =============================================================================
// Helper: pre-compute `recommended_preamp_db` from current bands
// =============================================================================

/// Compute the recommended preamp gain (in dB) to avoid post-EQ clipping.
/// Delegates to math-iir-fir's `peq_preamp_gain` if available, otherwise
/// falls back to a simple heuristic.
pub fn recommended_preamp_gain(bands: &[BandConfig]) -> f64 {
    // Use the crate's built-in preamp gain computation.
    // It analyzes the combined frequency response and suggests a safe
    // negative gain to prevent clipping.
    let peq: math_audio_iir_fir::Peq<f64> = bands
        .iter()
        .filter(|b| b.enabled)
        .map(|b| {
            let bq = math_audio_iir_fir::Biquad::new(
                match b.filter_type {
                    1 => math_audio_iir_fir::BiquadFilterType::Lowshelf,
                    2 => math_audio_iir_fir::BiquadFilterType::Highshelf,
                    3 => math_audio_iir_fir::BiquadFilterType::Lowpass,
                    4 => math_audio_iir_fir::BiquadFilterType::Highpass,
                    _ => math_audio_iir_fir::BiquadFilterType::Peak,
                },
                b.freq,
                48000.0, // sample rate for preamp calc (approximate)
                b.q.max(0.01),
                b.gain_db,
            );
            (1.0f64, bq)
        })
        .collect();
    math_audio_iir_fir::peq_preamp_gain(&peq)
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
        fn next(&mut self) -> Option<f32> {
            self.data.next()
        }
    }
    impl Source for TestSource {
        fn current_frame_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> u16 {
            1
        }
        fn sample_rate(&self) -> u32 {
            self.sr
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
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

        let src = TestSource {
            data: samples.into_iter(),
            sr,
        };
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

        let src = TestSource {
            data: samples.into_iter(),
            sr,
        };
        let eq = EqSource::new(src, params);

        let out: Vec<f32> = eq.skip(4096).collect();
        let sum_sq: f32 = out.iter().map(|x| x * x).sum();
        let rms = (sum_sq / out.len() as f32).sqrt();
        assert!(
            (rms - 0.3536).abs() < 0.01,
            "flat PEQ not transparent: rms={rms}"
        );
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
            let eq = EqSource::new(
                TestSource {
                    data: make_samples().into_iter(),
                    sr,
                },
                params_flat,
            );
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
            let eq = EqSource::new(
                TestSource {
                    data: make_samples().into_iter(),
                    sr,
                },
                params_boost,
            );
            let out: Vec<f32> = eq.skip(4096).collect();
            let s: f32 = out.iter().map(|x| x * x).sum();
            (s / out.len() as f32).sqrt()
        };

        let ratio_db = 20.0 * (boost_rms / flat_rms).log10();
        assert!(
            ratio_db > 9.0,
            "PEQ +12 dB boost at 1 kHz, got {ratio_db} dB"
        );
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    struct Sine {
        data: std::vec::IntoIter<f32>,
        sr: u32,
    }
    impl Iterator for Sine {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            self.data.next()
        }
    }
    impl Source for Sine {
        fn current_frame_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> u16 {
            1
        }
        fn sample_rate(&self) -> u32 {
            self.sr
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    #[test]
    fn live_param_change_is_picked_up() {
        let sr = 44_100u32;
        let params = Arc::new(EqParams::new());
        params.set(true, 0.0, [0f32; BAND_COUNT]);

        let samples: Vec<f32> = (0..sr as usize * 2)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * 0.5)
            .collect();
        let mut eq = EqSource::new(
            Sine {
                data: samples.into_iter(),
                sr,
            },
            Arc::clone(&params),
        );

        for _ in 0..sr as usize / 2 {
            eq.next();
        }

        let mut gains = [0f32; BAND_COUNT];
        gains[5] = 12.0;
        params.set(true, 0.0, gains);

        for _ in 0..sr as usize / 2 {
            eq.next();
        }
        let out: Vec<f32> = (0..sr as usize / 2).filter_map(|_| eq.next()).collect();
        let rms = (out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32).sqrt();
        assert!(rms > 1.0, "live change not applied, rms={rms}");
    }
}

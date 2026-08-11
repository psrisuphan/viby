// =============================================================================
// audio/eq.rs — 10-band graphic + 8-band parametric equalizer (DspEngine)
// =============================================================================
//
// The EQ is inserted into the rodio Source chain right after decoding:
//
//   Decoder → EqSource → Sink → cpal → hardware
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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use rodio::Source;

use crate::audio::dsp::quantize_db_f64;
pub use crate::audio::dsp::{BandConfig, DspEngine, Topology};

/// Number of GEQ bands (fixed 10-band layout).
pub const BAND_COUNT: usize = 10;

/// Number of PEQ bands.
pub const PEQ_BAND_COUNT: usize = 10;

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
        self.preamp_db.store(
            (quantize_db_f64(preamp_db as f64) as f32).to_bits(),
            Ordering::Relaxed,
        );
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
        self.preamp_db.store(
            (quantize_db_f64(preamp_db as f64) as f32).to_bits(),
            Ordering::Relaxed,
        );
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

    pub fn apply_snapshot(&self, snap: &EqSnapshot) {
        if snap.peq_mode {
            let bands = std::array::from_fn(|i| {
                let band = snap.peq_bands[i];
                (band.enabled, band.filter_type, band.freq, band.gain, band.q)
            });
            self.set_peq(snap.enabled, snap.preamp_db, bands);
        } else {
            self.set(snap.enabled, snap.preamp_db, snap.gains_db);
        }
    }
}

impl Default for EqParams {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
pub struct PeqBandSnapshot {
    pub enabled: bool,
    pub filter_type: u8,
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

#[derive(Clone, Copy)]
pub struct EqSnapshot {
    pub enabled: bool,
    pub preamp_db: f32,
    pub peq_mode: bool,
    pub gains_db: [f32; BAND_COUNT],
    pub peq_bands: [PeqBandSnapshot; PEQ_BAND_COUNT],
    pub oversampling: u8,
    pub topology: u8,
}

#[derive(Clone, Copy)]
struct ResponseCoeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

fn normalize_coeffs(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> ResponseCoeffs {
    ResponseCoeffs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn peaking_response_coeffs(
    freq: f64,
    gain_db: f64,
    q: f64,
    sample_rate: f64,
) -> Option<ResponseCoeffs> {
    if gain_db.abs() < 0.005 {
        return None;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let c = w.cos();
    let s = w.sin();
    let alpha = s / (2.0 * q);
    Some(normalize_coeffs(
        1.0 + alpha * a,
        -2.0 * c,
        1.0 - alpha * a,
        1.0 + alpha / a,
        -2.0 * c,
        1.0 - alpha / a,
    ))
}

fn low_shelf_response_coeffs(
    freq: f64,
    gain_db: f64,
    q: f64,
    sample_rate: f64,
) -> Option<ResponseCoeffs> {
    if gain_db.abs() < 0.005 {
        return None;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let c = w.cos();
    let s = w.sin();
    let alpha = s / (2.0 * q);
    let t = 2.0 * a.sqrt() * alpha;
    Some(normalize_coeffs(
        a * ((a + 1.0) - (a - 1.0) * c + t),
        2.0 * a * ((a - 1.0) - (a + 1.0) * c),
        a * ((a + 1.0) - (a - 1.0) * c - t),
        (a + 1.0) + (a - 1.0) * c + t,
        -2.0 * ((a - 1.0) + (a + 1.0) * c),
        (a + 1.0) + (a - 1.0) * c - t,
    ))
}

fn high_shelf_response_coeffs(
    freq: f64,
    gain_db: f64,
    q: f64,
    sample_rate: f64,
) -> Option<ResponseCoeffs> {
    if gain_db.abs() < 0.005 {
        return None;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let c = w.cos();
    let s = w.sin();
    let alpha = s / (2.0 * q);
    let t = 2.0 * a.sqrt() * alpha;
    Some(normalize_coeffs(
        a * ((a + 1.0) + (a - 1.0) * c + t),
        -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
        a * ((a + 1.0) + (a - 1.0) * c - t),
        (a + 1.0) - (a - 1.0) * c + t,
        2.0 * ((a - 1.0) - (a + 1.0) * c),
        (a + 1.0) - (a - 1.0) * c - t,
    ))
}

fn low_pass_response_coeffs(freq: f64, q: f64, sample_rate: f64) -> ResponseCoeffs {
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let c = w.cos();
    let s = w.sin();
    let alpha = s / (2.0 * q);
    let a0 = 1.0 + alpha;
    ResponseCoeffs {
        b0: (1.0 - c) / 2.0 / a0,
        b1: (1.0 - c) / a0,
        b2: (1.0 - c) / 2.0 / a0,
        a1: -2.0 * c / a0,
        a2: (1.0 - alpha) / a0,
    }
}

fn high_pass_response_coeffs(freq: f64, q: f64, sample_rate: f64) -> ResponseCoeffs {
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let c = w.cos();
    let s = w.sin();
    let alpha = s / (2.0 * q);
    let a0 = 1.0 + alpha;
    ResponseCoeffs {
        b0: (1.0 + c) / 2.0 / a0,
        b1: -(1.0 + c) / a0,
        b2: (1.0 + c) / 2.0 / a0,
        a1: -2.0 * c / a0,
        a2: (1.0 - alpha) / a0,
    }
}

fn response_coeffs_for_band(band: &BandConfig, sample_rate: f64) -> Option<ResponseCoeffs> {
    if !band.enabled {
        return None;
    }
    let nyquist = sample_rate * 0.5;
    let freq = band.freq.clamp(1.0, nyquist - 1.0);
    let q = band.q.max(0.01);
    match BandType::from_u8(band.filter_type) {
        BandType::LowShelf => low_shelf_response_coeffs(freq, band.gain_db, q, sample_rate),
        BandType::HighShelf => high_shelf_response_coeffs(freq, band.gain_db, q, sample_rate),
        BandType::LowPass => Some(low_pass_response_coeffs(freq, q, sample_rate)),
        BandType::HighPass => Some(high_pass_response_coeffs(freq, q, sample_rate)),
        BandType::Peaking => peaking_response_coeffs(freq, band.gain_db, q, sample_rate),
    }
}

pub fn graphic_band_configs(gains_db: &[f32; BAND_COUNT]) -> Vec<BandConfig> {
    (0..BAND_COUNT)
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
                gain_db: gains_db[i] as f64,
                q,
            }
        })
        .collect()
}

pub fn response_db_at(bands: &[BandConfig], freq_hz: f64, preamp_db: f64, sample_rate: f64) -> f64 {
    let sample_rate = sample_rate.max(1.0);
    let freq_hz = freq_hz.clamp(1.0, sample_rate * 0.5 - 1.0);
    let wf = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
    let cos1 = wf.cos();
    let cos2 = (2.0 * wf).cos();
    let sin1 = wf.sin();
    let sin2 = (2.0 * wf).sin();
    let mut db = preamp_db;

    for band in bands {
        let Some(coeffs) = response_coeffs_for_band(band, sample_rate) else {
            continue;
        };
        let nr = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2;
        let ni = -(coeffs.b1 * sin1 + coeffs.b2 * sin2);
        let dr = 1.0 + coeffs.a1 * cos1 + coeffs.a2 * cos2;
        let di = -(coeffs.a1 * sin1 + coeffs.a2 * sin2);
        let mag2 = (nr * nr + ni * ni) / (dr * dr + di * di).max(1e-30);
        db += 10.0 * mag2.max(1e-30).log10();
    }

    db
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

    // Oversampling buffers: collect one interleaved input frame, then drain one
    // processed output frame sample-by-sample.
    frame_in: Vec<f64>,
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
            frame_in: vec![0.0; channels],
            frame_out: vec![0.0; channels],
            frame_out_pos: 0,
            frame_out_count: 0,
        };
        src.recompute();
        src
    }

    fn recompute(&mut self) {
        let observed_generation = self.params.generation();
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

        self.last_generation = observed_generation;
    }
}

impl<S> Iterator for EqSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        // Drain a prepared output frame sample-by-sample.
        if self.frame_out_count > 0 {
            let sample = self.frame_out[self.frame_out_pos] as f32;
            self.frame_out_pos += 1;
            self.frame_out_count -= 1;
            return Some(sample);
        }

        if self.counter >= RECHECK_INTERVAL {
            self.counter = 0;
            if self.params.generation() != self.last_generation {
                self.recompute();
            }
        }

        let sample = self.inner.next()?;
        self.counter += 1;

        // Keep channel accounting aligned even while EQ is disabled.
        let ch = self.current_channel;
        self.current_channel += 1;
        if self.current_channel >= self.channels {
            self.current_channel = 0;
        }

        if !self.enabled {
            return Some(sample);
        }

        // Keep playback on the stable direct path for now. The block-based
        // oversampling path in DspEngine has sinc latency/drain semantics that
        // need a dedicated FIFO before it can be used without duplicating or
        // reordering audio at block boundaries.

        // Per-sample processing via DspEngine (zero-allocation hot path)
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
            self.frame_in.fill(0.0);
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
pub fn recommended_preamp_gain(bands: &[BandConfig], sample_rate: f64) -> f64 {
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
                sample_rate.max(1.0),
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

    fn peq_rms_at(freq_hz: f32, oversampling: u8) -> f32 {
        let sr = 44_100u32;
        let n = sr as usize * 2;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq_hz * i as f32 / sr as f32).sin() * 0.25)
            .collect();

        let params = Arc::new(EqParams::new());
        params.set_oversampling(oversampling);
        let mut bands = std::array::from_fn(|_| (false, 0u8, 1000f32, 0f32, 1f32));
        bands[3] = (true, 0, 1000.0, 12.0, 2.0);
        params.set_peq(true, 0.0, bands);

        let eq = EqSource::new(
            TestSource {
                data: samples.into_iter(),
                sr,
            },
            params,
        );
        let out: Vec<f32> = eq.skip(8192).collect();
        let sum_sq: f32 = out.iter().map(|x| x * x).sum();
        (sum_sq / out.len() as f32).sqrt()
    }

    #[test]
    fn oversampling_request_flat_peq_preserves_sample_count_and_transparency() {
        let sr = 44_100u32;
        let samples: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin() * 0.25)
            .collect();

        let params = Arc::new(EqParams::new());
        params.set_oversampling(4);
        let bands = std::array::from_fn(|_| (true, 0u8, 1000f32, 0f32, 1f32));
        params.set_peq(true, 0.0, bands);

        let src = TestSource {
            data: samples.clone().into_iter(),
            sr,
        };
        let out: Vec<f32> = EqSource::new(src, params).collect();

        assert_eq!(out.len(), samples.len());
        let max_err = out
            .iter()
            .zip(samples.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_err < 1.0e-3,
            "flat PEQ altered audio: max_err={max_err}"
        );
    }

    #[test]
    fn oversampled_2x_peq_peak_stays_at_1k() {
        let at_500 = peq_rms_at(500.0, 2);
        let at_1k = peq_rms_at(1000.0, 2);
        assert!(
            at_1k > at_500 * 1.35,
            "2x oversampled PEQ should peak nearer 1 kHz than 500 Hz: 500={at_500}, 1k={at_1k}"
        );
    }

    #[test]
    fn oversampled_4x_peq_peak_stays_at_1k() {
        let at_500 = peq_rms_at(500.0, 4);
        let at_1k = peq_rms_at(1000.0, 4);
        assert!(
            at_1k > at_500 * 1.35,
            "4x oversampled PEQ should peak nearer 1 kHz than 500 Hz: 500={at_500}, 1k={at_1k}"
        );
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
        assert!(
            ratio_db > 7.0,
            "expected a strong boost below the safety ceiling, got {ratio_db} dB"
        );
    }

    #[test]
    fn cut_decreases_amplitude() {
        let flat = rms_at_1k(0.0, true);
        let cut = rms_at_1k(-12.0, true);
        let ratio_db = 20.0 * (cut / flat).log10();
        assert!(ratio_db < -9.0, "expected ~-12 dB, got {ratio_db} dB");
    }

    #[test]
    fn response_db_returns_preamp_for_flat_bands() {
        let bands = vec![BandConfig {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain_db: 0.0,
            q: 1.0,
        }];

        let db = response_db_at(&bands, 1000.0, -3.0, 48_000.0);
        assert!((db + 3.0).abs() < 1.0e-6, "expected -3 dB, got {db}");
    }

    #[test]
    fn response_db_matches_peaking_center_gain() {
        let bands = vec![BandConfig {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain_db: 6.0,
            q: 1.0,
        }];

        let db = response_db_at(&bands, 1000.0, 0.0, 48_000.0);
        assert!((db - 6.0).abs() < 0.05, "expected about +6 dB, got {db}");
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
            ratio_db > 7.0,
            "PEQ +12 dB boost at 1 kHz should remain strong below the safety ceiling, got {ratio_db} dB"
        );
    }

    #[test]
    fn preamp_snapshot_uses_centi_db_steps() {
        let params = EqParams::new();
        params.set(false, 1.234, [0.0; BAND_COUNT]);
        assert_eq!(params.snapshot().preamp_db, 1.23);
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
        assert!(rms > 0.8, "live change not applied, rms={rms}");
    }
}

// =============================================================================
// audio/dsp.rs — Audiophile-grade DSP engine (TDF2 biquads, SVF, oversampling)
// =============================================================================
//
// This module replaces the hand-rolled BiquadFilter in eq.rs with a proper
// DSP engine using:
//
//   - `math_audio_iir_fir::Biquad` — TDF2 biquads with f64 precision
//   - `math_audio_iir_fir::SvfFilter` — ZDF (TPT) state-variable filter
//   - `rubato` — high-quality sinc resampler for oversampling
//
// The engine supports sample-by-sample processing when oversampling is off,
// and block-based processing when oversampling is active.
// =============================================================================

use math_audio_iir_fir::{Biquad, BiquadFilterType, SvfFilter, SvfFilterType};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

// ── Block size for oversampled processing (input frames per channel) ─────────
const OVERSAMPLED_BLOCK_SIZE: usize = 256;

// ── Topology ─────────────────────────────────────────────────────────────────

/// Filter bank topology.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Topology {
    /// Transposed Direct Form 2 (standard biquad).
    /// Good general-purpose choice; recommended default.
    Tdf2 = 0,
    /// Zero-Delay Feedback State Variable Filter (TPT).
    /// Artifact-free parameter changes; useful for high-Q peaks (Q > 10).
    Svf = 1,
}

impl Topology {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Topology::Svf,
            _ => Topology::Tdf2,
        }
    }
}

// ── Filter type mapping ──────────────────────────────────────────────────────

/// Maps internal band type to the crate's BiquadFilterType.
fn to_biquad_type(kind: u8) -> BiquadFilterType {
    match kind {
        1 => BiquadFilterType::Lowshelf,
        2 => BiquadFilterType::Highshelf,
        3 => BiquadFilterType::Lowpass,
        4 => BiquadFilterType::Highpass,
        _ => BiquadFilterType::Peak,
    }
}

/// Maps internal band type to the crate's SvfFilterType.
fn to_svf_type(kind: u8) -> SvfFilterType {
    match kind {
        1 => SvfFilterType::Lowshelf,
        2 => SvfFilterType::Highshelf,
        3 => SvfFilterType::Lowpass,
        4 => SvfFilterType::Highpass,
        _ => SvfFilterType::Peak,
    }
}

// ── Per-band filter state ────────────────────────────────────────────────────

/// Holds one filter's runtime state per band per channel.
enum FilterState {
    /// TDF2 biquad.
    Biquad(Biquad<f64>),
    /// ZDF state-variable filter.
    Svf(SvfFilter<f64>),
}

impl FilterState {
    /// Create a new filter state based on topology.
    fn new(
        topology: Topology,
        kind: u8,
        freq: f64,
        gain_db: f64,
        q: f64,
        sample_rate: f64,
    ) -> Self {
        match topology {
            Topology::Tdf2 => {
                let mut bq = Biquad::new(to_biquad_type(kind), freq, sample_rate, q, gain_db);
                bq.use_tdf2 = true;
                FilterState::Biquad(bq)
            }
            Topology::Svf => FilterState::Svf(SvfFilter::new(
                to_svf_type(kind),
                freq,
                sample_rate,
                q,
                gain_db,
            )),
        }
    }

    /// Process one sample (f64).
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        match self {
            FilterState::Biquad(b) => b.process(x),
            FilterState::Svf(s) => s.process(x),
        }
    }
}

// ── Band configuration (snapshot of one PEQ/GEQ band) ────────────────────────

/// Snapshot of one EQ band's configuration.
#[derive(Clone)]
pub struct BandConfig {
    pub enabled: bool,
    pub filter_type: u8,
    pub freq: f64,
    pub gain_db: f64,
    pub q: f64,
}

// ── DspEngine ────────────────────────────────────────────────────────────────

/// The core DSP engine for equalization.
///
/// Manages per-channel filter banks, oversampling via rubato, and topology
/// switching between TDF2 and SVF.
pub struct DspEngine {
    /// Number of audio channels.
    channels: usize,
    /// Sample rate in Hz.
    sample_rate: f64,
    /// Oversampling factor (1, 2, or 4). 1 = off.
    oversampling: u8,
    /// Filter topology.
    topology: Topology,
    /// Per-channel filter banks.
    filters: Vec<Vec<FilterState>>,

    // ── Oversampling state (only used when oversampling > 1) ──
    /// Upsamplers, one per channel.
    upsamplers: Vec<SincFixedIn<f64>>,
    /// Downsamplers, one per channel.
    downsamplers: Vec<SincFixedIn<f64>>,
    /// Input buffer for block processing: Vec<[channel][sample]>.
    block_input: Vec<Vec<f64>>,
    /// Output buffer from block processing.
    block_output: Vec<Vec<f64>>,
    /// Number of valid output frames in block_output.
    block_output_frames: usize,
    /// Current read position in block_output (in frames).
    block_output_pos: usize,
    /// Current write position in block_input (in frames).
    block_input_pos: usize,

    // ── Pre-amp (linear gain) ──
    preamp_linear: f64,

    // ── Scratch buffers for process_block (reused each call, no per-block alloc) ──
    upsampled_buf: Vec<Vec<f64>>,
    downsampled_buf: Vec<Vec<f64>>,
}

impl DspEngine {
    /// Create a new DSP engine.
    pub fn new(channels: usize, sample_rate: f64, oversampling: u8, topology: Topology) -> Self {
        let mut engine = DspEngine {
            channels,
            sample_rate,
            oversampling,
            topology,
            filters: Vec::new(),
            upsamplers: Vec::new(),
            downsamplers: Vec::new(),
            block_input: Vec::new(),
            block_output: Vec::new(),
            block_output_frames: 0,
            block_output_pos: 0,
            block_input_pos: 0,
            preamp_linear: 1.0,
            upsampled_buf: Vec::new(),
            downsampled_buf: Vec::new(),
        };
        engine.rebuild_resamplers();
        engine
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /// Set or update sample rate. Rebuilds resamplers if needed.
    pub fn set_sample_rate(&mut self, sr: f64) {
        if (self.sample_rate - sr).abs() < 0.5 {
            return;
        }
        self.sample_rate = sr;
        self.rebuild_resamplers();
    }

    /// Set the number of channels. Rebuilds filter banks and resamplers.
    pub fn set_channels(&mut self, ch: usize) {
        if self.channels == ch {
            return;
        }
        self.channels = ch;
        self.rebuild_filters(0, &[]); // identity filters
        self.rebuild_resamplers();
    }

    /// Set oversampling ratio (1, 2, or 4). Rebuilds resamplers.
    pub fn set_oversampling(&mut self, ratio: u8) {
        let ratio = ratio.clamp(1, 4);
        if self.oversampling == ratio {
            return;
        }
        self.oversampling = ratio;
        self.rebuild_resamplers();
        // Clear any buffered data when changing oversampling
        self.flush_buffers();
    }

    /// Set topology (TDF2 or SVF). The next `recompute()` call will rebuild
    /// filter banks with the new topology. No immediate change — this avoids
    /// audible artifacts from rebuilding coefficients mid-stream.
    pub fn set_topology(&mut self, topology: Topology) {
        self.topology = topology;
    }

    /// Set preamp gain in dB.
    pub fn set_preamp_db(&mut self, db: f64) {
        self.preamp_linear = 10f64.powf(db / 20.0);
    }

    /// Recompute filter coefficients from band configurations.
    /// Call this when EQ parameters change.
    pub fn recompute(&mut self, bands: &[BandConfig]) {
        self.rebuild_filters(self.channels, bands);
    }

    // ── Processing ───────────────────────────────────────────────────────────

    /// Process a single sample for a given channel (zero-allocation hot path).
    /// Used when oversampling is 1 (direct mode).
    #[inline]
    pub fn process_sample(&mut self, channel: usize, sample: f64) -> f64 {
        let mut y = sample;
        if channel < self.filters.len() {
            for filter in self.filters[channel].iter_mut() {
                y = filter.process(y);
            }
        }
        y * self.preamp_linear
    }

    /// Process one interleaved frame (all channels).
    /// Writes output into `output` slice (pre-allocated, length == channels).
    /// When oversampling is active, internally buffers frames and processes
    /// them in blocks. When oversampling is 1, processes inline.
    #[inline]
    pub fn process_frame(&mut self, input: &[f64], output: &mut [f64]) {
        debug_assert_eq!(input.len(), self.channels);
        debug_assert_eq!(output.len(), self.channels);

        if self.oversampling == 1 {
            for (ch, (&sample, out)) in input.iter().zip(output.iter_mut()).enumerate() {
                *out = self.process_sample(ch, sample);
            }
            return;
        }

        // Drain pending oversampled output before accepting more input. EqSource
        // normally observes this through has_pending_output(), but keeping the
        // guard here prevents block_input_pos from writing out of bounds if the
        // API is used directly.
        if self.drain_frame(output) {
            return;
        }

        if self.block_input_pos >= OVERSAMPLED_BLOCK_SIZE {
            self.process_block();
            if self.drain_frame(output) {
                return;
            }
            self.block_input_pos = 0;
        }

        // Buffered block processing: store one complete frame per channel.
        for (ch, &sample) in input.iter().enumerate() {
            if ch < self.block_input.len() && self.block_input_pos < self.block_input[ch].len() {
                self.block_input[ch][self.block_input_pos] = sample;
            }
        }
        self.block_input_pos += 1;

        if self.block_input_pos >= OVERSAMPLED_BLOCK_SIZE {
            self.process_block();
            if self.drain_frame(output) {
                return;
            }
        }

        // Not enough samples yet to fill a resampling block. Preserve streaming
        // behavior by passing this frame through until processed output exists.
        output.copy_from_slice(input);
    }

    /// Return true when oversampled block output is waiting to be drained.
    #[inline]
    pub fn has_pending_output(&self) -> bool {
        self.block_output_frames > 0
    }

    /// Return true when the engine is configured for oversampled frame processing.
    #[inline]
    pub fn is_oversampling(&self) -> bool {
        self.oversampling > 1
    }

    /// Drain one frame from block_output into `output`.
    #[inline]
    pub fn drain_frame(&mut self, output: &mut [f64]) -> bool {
        if self.block_output_frames == 0 {
            return false;
        }

        let pos = self.block_output_pos;
        for (ch, out) in output.iter_mut().enumerate() {
            *out = if ch < self.block_output.len() && pos < self.block_output[ch].len() {
                self.block_output[ch][pos]
            } else {
                0.0
            };
        }
        self.block_output_pos += 1;
        self.block_output_frames -= 1;

        if self.block_output_frames == 0 {
            self.block_output_pos = 0;
            self.block_input_pos = 0;
        }
        true
    }

    /// Process a full block through the oversampling pipeline.
    fn process_block(&mut self) {
        let n = OVERSAMPLED_BLOCK_SIZE;

        // 1. Upsample each channel into pre-allocated scratch buffer
        let mut up_n = 0;
        for ch in 0..self.channels {
            if ch >= self.upsamplers.len()
                || ch >= self.block_input.len()
                || ch >= self.upsampled_buf.len()
            {
                continue;
            }
            let input_ch = &self.block_input[ch][..n];
            let out_buf = &mut self.upsampled_buf[ch];
            let (_, written) = self.upsamplers[ch]
                .process_into_buffer(&[input_ch], &mut [&mut out_buf[..]], None)
                .unwrap_or((0, 0));
            if ch == 0 {
                up_n = written;
            }
        }

        // 2. Apply filters at the upsampled rate
        for sample_idx in 0..up_n {
            for ch in 0..self.channels {
                if ch < self.filters.len()
                    && ch < self.upsampled_buf.len()
                    && sample_idx < self.upsampled_buf[ch].len()
                {
                    let mut y = self.upsampled_buf[ch][sample_idx];
                    for filter in self.filters[ch].iter_mut() {
                        y = filter.process(y);
                    }
                    y *= self.preamp_linear;
                    self.upsampled_buf[ch][sample_idx] = y;
                }
            }
        }

        // 3. Downsample each channel into pre-allocated scratch buffer
        let mut out_frames = 0;
        for ch in 0..self.channels {
            if ch >= self.downsamplers.len()
                || ch >= self.upsampled_buf.len()
                || ch >= self.downsampled_buf.len()
            {
                continue;
            }
            let input_ch = &self.upsampled_buf[ch][..up_n];
            let out_buf = &mut self.downsampled_buf[ch];
            let max_out = self.downsamplers[ch]
                .output_frames_next()
                .min(out_buf.len());
            let (_, written) = self.downsamplers[ch]
                .process_into_buffer(&[input_ch], &mut [&mut out_buf[..max_out]], None)
                .unwrap_or((0, 0));
            if ch == 0 {
                out_frames = written.min(n);
            }
        }

        // 4. Copy to block_output
        for ch in 0..self.channels {
            if ch < self.block_output.len() && ch < self.downsampled_buf.len() {
                self.block_output[ch][..out_frames]
                    .copy_from_slice(&self.downsampled_buf[ch][..out_frames]);
            }
        }
        self.block_output_frames = out_frames;
        self.block_output_pos = 0;
    }

    /// Flush internal buffers (e.g., after seeking or parameter changes).
    pub fn flush_buffers(&mut self) {
        self.block_input_pos = 0;
        self.block_output_frames = 0;
        self.block_output_pos = 0;
        for buf in self.block_input.iter_mut() {
            buf.fill(0.0);
        }
        for resampler in self.upsamplers.iter_mut() {
            resampler.reset();
        }
        for resampler in self.downsamplers.iter_mut() {
            resampler.reset();
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// The sample rate at which filters are actually applied.
    /// EqSource currently uses the stable per-sample path for playback, so
    /// filters must be built for the source sample rate even if the UI requests
    /// oversampling. The block oversampling path remains unused until it has a
    /// latency-compensated FIFO.
    fn filter_sample_rate(&self) -> f64 {
        self.sample_rate
    }

    fn rebuild_filters(&mut self, channels: usize, bands: &[BandConfig]) {
        let fs = self.filter_sample_rate();
        self.filters = (0..channels)
            .map(|_| {
                bands
                    .iter()
                    .filter(|b| b.enabled)
                    .map(|b| {
                        FilterState::new(
                            self.topology,
                            b.filter_type,
                            b.freq,
                            b.gain_db,
                            b.q.max(0.01),
                            fs,
                        )
                    })
                    .collect()
            })
            .collect();
    }

    fn rebuild_resamplers(&mut self) {
        if self.oversampling <= 1 {
            self.upsamplers.clear();
            self.downsamplers.clear();
            self.block_input.clear();
            self.block_output.clear();
            return;
        }

        let ratio = self.oversampling as f64;
        // Helper to create sinc interpolation parameters (same config each call)
        let mk_params = || SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        // Create upsamplers for each channel
        self.upsamplers.clear();
        for _ in 0..self.channels {
            match SincFixedIn::<f64>::new(ratio, 1.0, mk_params(), OVERSAMPLED_BLOCK_SIZE, 1) {
                Ok(r) => self.upsamplers.push(r),
                Err(e) => eprintln!("[DspEngine] Failed to create upsampler: {:?}", e),
            }
        }

        // Create downsamplers for each channel
        self.downsamplers.clear();
        for _ in 0..self.channels {
            match SincFixedIn::<f64>::new(
                1.0 / ratio,
                1.0,
                mk_params(),
                (OVERSAMPLED_BLOCK_SIZE as f64 * ratio).ceil() as usize,
                1,
            ) {
                Ok(r) => self.downsamplers.push(r),
                Err(e) => eprintln!("[DspEngine] Failed to create downsampler: {:?}", e),
            }
        }

        // Pre-allocate block buffers (I/O and scratch)
        let ch = self.channels;
        let n = OVERSAMPLED_BLOCK_SIZE;
        let n_up = (n as f64 * ratio).ceil() as usize;
        let resampler_margin = 64;
        self.block_input = (0..ch).map(|_| vec![0.0; n]).collect();
        self.block_output = (0..ch).map(|_| vec![0.0; n]).collect();
        self.upsampled_buf = (0..ch)
            .map(|_| vec![0.0; n_up + resampler_margin])
            .collect();
        self.downsampled_buf = (0..ch).map(|_| vec![0.0; n + resampler_margin]).collect();
        self.block_output_frames = 0;
        self.block_output_pos = 0;
        self.block_input_pos = 0;
    }
}

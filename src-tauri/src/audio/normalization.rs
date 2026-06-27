use std::fs::File;
use std::sync::Arc;
use std::sync::atomic::AtomicI32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ebur128_stream::{AnalyzerBuilder, Channel, Mode};
use rodio::Source;

use crate::audio::decoder::SymphoniaDecoder;

pub const TARGET_LUFS: f32 = -16.0;
const LUFS_SCALE: f32 = 100.0;

#[derive(Debug)]
pub struct NormalizationParams {
    enabled: AtomicBool,
    target_lufs_cdb: AtomicI32,
}

impl NormalizationParams {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            target_lufs_cdb: AtomicI32::new((TARGET_LUFS * LUFS_SCALE) as i32),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_target_lufs(&self, target_lufs: f32) {
        let target_lufs_cdb = (target_lufs * LUFS_SCALE).round() as i32;
        self.target_lufs_cdb
            .store(target_lufs_cdb, Ordering::Relaxed);
    }

    pub fn target_lufs(&self) -> f32 {
        self.target_lufs_cdb.load(Ordering::Relaxed) as f32 / LUFS_SCALE
    }

    pub fn target_offset_db(&self) -> f32 {
        self.target_lufs() - TARGET_LUFS
    }
}

pub struct NormalizationSource<S> {
    input: S,
    params: Arc<NormalizationParams>,
    base_gain_db: Option<f32>,
    peak: Option<f32>,
    cached_offset_db: f32,
    multiplier: f32,
}

impl<S> NormalizationSource<S> {
    pub fn new(
        input: S,
        params: Arc<NormalizationParams>,
        gain_db: Option<f32>,
        peak: Option<f32>,
    ) -> Self {
        let base_gain_db = gain_db.map(|gain| effective_gain_db(gain, peak));
        let cached_offset_db = params.target_offset_db();
        let multiplier = base_gain_db
            .map(|gain| db_to_linear(effective_gain_db(gain + cached_offset_db, peak)))
            .unwrap_or(1.0);
        Self {
            input,
            params,
            base_gain_db,
            peak,
            cached_offset_db,
            multiplier,
        }
    }
}

impl<S> Iterator for NormalizationSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.input.next()?;
        if self.params.enabled() {
            let offset_db = self.params.target_offset_db();
            if (offset_db - self.cached_offset_db).abs() > f32::EPSILON {
                self.cached_offset_db = offset_db;
                self.multiplier = self
                    .base_gain_db
                    .map(|gain| db_to_linear(effective_gain_db(gain + offset_db, self.peak)))
                    .unwrap_or(1.0);
            }
            Some(sample * self.multiplier)
        } else {
            Some(sample)
        }
    }
}

impl<S> Source for NormalizationSource<S>
where
    S: Source<Item = f32>,
{
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        self.input.current_frame_len()
    }

    #[inline]
    fn channels(&self) -> u16 {
        self.input.channels()
    }

    #[inline]
    fn sample_rate(&self) -> u32 {
        self.input.sample_rate()
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.input.try_seek(pos)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct NormalizationAnalysis {
    pub gain_db: f32,
    pub peak: f32,
}

pub fn analyze_file(path: &str) -> Result<Option<NormalizationAnalysis>, String> {
    let file =
        File::open(path).map_err(|e| format!("Failed to open '{path}' for normalization: {e}"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str());
    let mut source = SymphoniaDecoder::new(file, extension)
        .map_err(|e| format!("Failed to decode '{path}' for normalization: {e}"))?;
    let channels = source.channels();
    let channel_layout = channel_layout(channels);
    let mut analyzer = AnalyzerBuilder::new()
        .sample_rate(source.sample_rate())
        .channels(&channel_layout)
        .modes(Mode::Integrated | Mode::TruePeak)
        .build()
        .map_err(|e| format!("Failed to create loudness analyzer for '{path}': {e}"))?;

    let chunk_samples = (source.sample_rate() as usize)
        .saturating_mul(channels as usize)
        .max(4096);
    let mut buffer = Vec::with_capacity(chunk_samples);
    let mut sample_peak = 0.0_f32;

    while let Some(sample) = source.next() {
        if sample.is_finite() {
            sample_peak = sample_peak.max(sample.abs());
            buffer.push(sample);
        } else {
            buffer.push(0.0);
        }

        if buffer.len() >= chunk_samples {
            analyzer
                .push_interleaved(&buffer)
                .map_err(|e| format!("Failed to analyze '{path}': {e}"))?;
            buffer.clear();
        }
    }

    if !buffer.is_empty() {
        analyzer
            .push_interleaved(&buffer)
            .map_err(|e| format!("Failed to analyze '{path}': {e}"))?;
    }

    let report = analyzer.finalize();
    let Some(lufs) = report.integrated_lufs() else {
        return Ok(None);
    };

    let true_peak = report
        .true_peak_dbtp()
        .map(|dbtp| db_to_linear(dbtp as f32))
        .unwrap_or(sample_peak)
        .max(sample_peak)
        .max(f32::MIN_POSITIVE);
    let requested_gain = TARGET_LUFS - lufs as f32;
    let gain_db = effective_gain_db(requested_gain, Some(true_peak));

    Ok(Some(NormalizationAnalysis {
        gain_db,
        peak: true_peak,
    }))
}

pub fn effective_gain_db(gain_db: f32, peak: Option<f32>) -> f32 {
    if !gain_db.is_finite() {
        return 0.0;
    }

    let Some(peak) = peak.filter(|peak| peak.is_finite() && *peak > 0.0) else {
        return gain_db;
    };

    if gain_db <= 0.0 {
        gain_db
    } else {
        gain_db.min(-20.0 * peak.log10())
    }
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn channel_layout(channels: u16) -> Vec<Channel> {
    match channels {
        0 => vec![Channel::Other],
        1 => vec![Channel::Center],
        2 => vec![Channel::Left, Channel::Right],
        3 => vec![Channel::Left, Channel::Right, Channel::Center],
        4 => vec![
            Channel::Left,
            Channel::Right,
            Channel::LeftSurround,
            Channel::RightSurround,
        ],
        5 => vec![
            Channel::Left,
            Channel::Right,
            Channel::Center,
            Channel::LeftSurround,
            Channel::RightSurround,
        ],
        _ => {
            let mut layout = vec![
                Channel::Left,
                Channel::Right,
                Channel::Center,
                Channel::Lfe,
                Channel::LeftSurround,
                Channel::RightSurround,
            ];
            layout.extend(std::iter::repeat_n(
                Channel::Other,
                channels.saturating_sub(6) as usize,
            ));
            layout
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_gain_is_capped_by_peak() {
        assert!((effective_gain_db(10.0, Some(0.5)) - 6.0206).abs() < 0.01);
        assert_eq!(effective_gain_db(2.0, Some(0.5)), 2.0);
    }

    #[test]
    fn negative_gain_is_not_peak_capped() {
        assert_eq!(effective_gain_db(-4.0, Some(1.2)), -4.0);
    }

    #[test]
    fn target_offset_changes_target_loudness() {
        let params = NormalizationParams::new(true);
        assert_eq!(params.target_offset_db(), 0.0);
        params.set_target_lufs(-14.0);
        assert_eq!(params.target_offset_db(), 2.0);
    }
}

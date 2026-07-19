use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{OutputStream, OutputStreamHandle, StreamError};
use std::time::Duration;

const COLD_OUTPUT_WARMUP: Duration = Duration::from_millis(150);

pub struct AudioOutput {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    summary: OutputSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSummary {
    pub sample_rate: u32,
    pub channels: u32,
    pub sample_format: String,
    pub fallback_reason: Option<String>,
}

impl AudioOutput {
    pub fn open_default() -> Result<Self, StreamError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(StreamError::NoDevice)?;
        let config = device
            .default_output_config()
            .map_err(StreamError::DefaultStreamConfigError)?;
        open_config(&device, config, None)
    }

    pub fn open_for_source(
        source_sample_rate: u32,
        source_channels: u32,
    ) -> Result<Self, StreamError> {
        match open_native_for_source(source_sample_rate, source_channels) {
            Ok(output) => Ok(output),
            Err(native_err) => {
                let mut output = Self::open_default()?;
                output.summary.fallback_reason = Some(format!(
                    "native output {source_sample_rate} Hz / {source_channels} ch unavailable: {native_err}"
                ));
                Ok(output)
            }
        }
    }

    pub fn handle(&self) -> &OutputStreamHandle {
        &self.handle
    }

    pub fn summary(&self) -> &OutputSummary {
        &self.summary
    }

    pub fn is_native_for(&self, sample_rate: u32, channels: u32) -> bool {
        self.summary.sample_rate == sample_rate && self.summary.channels == channels
    }

    pub fn clear_fallback_if_native_for(&mut self, sample_rate: u32, channels: u32) {
        if self.is_native_for(sample_rate, channels) {
            self.summary.fallback_reason = None;
        }
    }
}

fn open_native_for_source(
    source_sample_rate: u32,
    source_channels: u32,
) -> Result<AudioOutput, StreamError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(StreamError::NoDevice)?;
    let default_config = device
        .default_output_config()
        .map_err(StreamError::DefaultStreamConfigError)?;
    let default_channels = default_config.channels();
    let default_format = default_config.sample_format();
    let supported = device
        .supported_output_configs()
        .map_err(StreamError::SupportedStreamConfigsError)?;

    let mut best = None;
    let mut best_score = None;
    for range in supported {
        if !(range.min_sample_rate().0 <= source_sample_rate
            && source_sample_rate <= range.max_sample_rate().0)
        {
            continue;
        }

        let score = config_score(
            range.channels(),
            range.sample_format(),
            source_channels,
            default_channels,
            default_format,
        );
        if best_score.is_none_or(|current| score > current) {
            best_score = Some(score);
            best = Some(range.with_sample_rate(cpal::SampleRate(source_sample_rate)));
        }
    }

    match best {
        Some(config) => open_config(&device, config, None),
        None => Err(StreamError::NoDevice),
    }
}

fn open_config(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    fallback_reason: Option<String>,
) -> Result<AudioOutput, StreamError> {
    let summary = OutputSummary {
        sample_rate: config.sample_rate().0,
        channels: u32::from(config.channels()),
        sample_format: config.sample_format().to_string(),
        fallback_reason,
    };
    let (_stream, handle) = OutputStream::try_from_device_config(device, config)?;
    // Let a newly started hardware stream consume silence before any track samples.
    std::thread::sleep(COLD_OUTPUT_WARMUP);
    Ok(AudioOutput {
        _stream,
        handle,
        summary,
    })
}

fn config_score(
    candidate_channels: u16,
    candidate_format: cpal::SampleFormat,
    source_channels: u32,
    default_channels: u16,
    default_format: cpal::SampleFormat,
) -> (u8, u8, u8, u32) {
    (
        u8::from(source_channels == u32::from(candidate_channels)),
        u8::from(candidate_format == default_format),
        sample_format_quality(candidate_format),
        u32::from(candidate_channels == default_channels) * 10_000 + u32::from(candidate_channels),
    )
}

fn sample_format_quality(format: cpal::SampleFormat) -> u8 {
    match format {
        cpal::SampleFormat::F32 => 100,
        cpal::SampleFormat::F64 => 95,
        cpal::SampleFormat::I32 | cpal::SampleFormat::U32 => 90,
        cpal::SampleFormat::I16 | cpal::SampleFormat::U16 => 80,
        cpal::SampleFormat::I8 | cpal::SampleFormat::U8 => 10,
        _ => 50,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_score_prefers_source_channels_before_default_format() {
        let stereo_default =
            config_score(2, cpal::SampleFormat::F32, 6, 2, cpal::SampleFormat::F32);
        let six_channel = config_score(6, cpal::SampleFormat::I16, 6, 2, cpal::SampleFormat::F32);

        assert!(six_channel > stereo_default);
    }

    #[test]
    fn config_score_prefers_default_format_when_channels_match() {
        let default_format =
            config_score(2, cpal::SampleFormat::F32, 2, 2, cpal::SampleFormat::F32);
        let non_default_format =
            config_score(2, cpal::SampleFormat::I16, 2, 2, cpal::SampleFormat::F32);

        assert!(default_format > non_default_format);
    }
}

use rodio::Source;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal, SignalSpec};
use symphonia::core::codecs::{CODEC_TYPE_NULL, Decoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekedTo};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{self, Time};

const MAX_DECODE_RETRIES: usize = 3;

pub struct SymphoniaOpusDecoder {
    params: symphonia::core::codecs::CodecParameters,
    decoder: opus_decoder::OpusDecoder,
    spec: SignalSpec,
    last_buf: symphonia::core::audio::AudioBuffer<f32>,
    out_pcm: Vec<i16>,
}

impl SymphoniaOpusDecoder {
    pub fn try_new(
        params: &symphonia::core::codecs::CodecParameters,
    ) -> Result<Self, symphonia::core::errors::Error> {
        let sample_rate = params.sample_rate.unwrap_or(48000);
        let channels_count = params.channels.map(|c| c.count()).unwrap_or(2);
        let channels = if channels_count == 1 {
            symphonia::core::audio::Channels::FRONT_LEFT
        } else {
            symphonia::core::audio::Channels::FRONT_LEFT
                | symphonia::core::audio::Channels::FRONT_RIGHT
        };
        let spec = SignalSpec::new(sample_rate, channels);
        let last_buf = symphonia::core::audio::AudioBuffer::new(0, spec);

        let decoder =
            opus_decoder::OpusDecoder::new(sample_rate, channels_count).map_err(|_| {
                symphonia::core::errors::Error::DecodeError("Failed to initialize Opus decoder")
            })?;

        Ok(Self {
            params: params.clone(),
            decoder,
            spec,
            last_buf,
            out_pcm: vec![0i16; 11520],
        })
    }
}

impl Decoder for SymphoniaOpusDecoder {
    fn try_new(
        params: &symphonia::core::codecs::CodecParameters,
        _options: &symphonia::core::codecs::DecoderOptions,
    ) -> Result<Self, symphonia::core::errors::Error>
    where
        Self: Sized,
    {
        Self::try_new(params)
    }

    fn supported_codecs() -> &'static [symphonia::core::codecs::CodecDescriptor] {
        &[]
    }

    fn reset(&mut self) {
        self.decoder.reset();
    }

    fn codec_params(&self) -> &symphonia::core::codecs::CodecParameters {
        &self.params
    }

    fn decode(
        &mut self,
        packet: &symphonia::core::formats::Packet,
    ) -> Result<AudioBufferRef<'_>, symphonia::core::errors::Error> {
        let pcm_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.decoder.decode(packet.buf(), &mut self.out_pcm, false)
        }));

        let samples_per_channel = match pcm_res {
            Ok(Ok(count)) => count,
            _ => 0,
        };

        let num_channels = self.spec.channels.count();
        let total_samples = samples_per_channel * num_channels;

        let mut buf =
            symphonia::core::audio::AudioBuffer::new(samples_per_channel as u64, self.spec);
        if samples_per_channel > 0 {
            buf.render_reserved(Some(samples_per_channel));

            for ch in 0..num_channels {
                let channel_data = buf.chan_mut(ch);
                for (i, sample) in channel_data.iter_mut().enumerate() {
                    let idx = i * num_channels + ch;
                    if idx < total_samples {
                        *sample = self.out_pcm[idx] as f32 / 32768.0;
                    }
                }
            }
        }

        self.last_buf = buf;
        Ok(AudioBufferRef::F32(std::borrow::Cow::Borrowed(
            &self.last_buf,
        )))
    }

    fn finalize(&mut self) -> symphonia::core::codecs::FinalizeResult {
        symphonia::core::codecs::FinalizeResult::default()
    }

    fn last_decoded(&self) -> AudioBufferRef<'_> {
        AudioBufferRef::F32(std::borrow::Cow::Borrowed(&self.last_buf))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_decoder_initialization() {
        let params = symphonia::core::codecs::CodecParameters::default();
        let decoder = SymphoniaOpusDecoder::try_new(&params);
        assert!(decoder.is_ok());
    }
}

pub struct SeekableFileSource {
    file: File,
    length: u64,
}

impl SeekableFileSource {
    pub fn new(file: File) -> Self {
        let length = file.metadata().map(|m| m.len()).unwrap_or(0);
        Self { file, length }
    }
}

impl Read for SeekableFileSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for SeekableFileSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

impl MediaSource for SeekableFileSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}

pub struct SymphoniaDecoder {
    decoder: Box<dyn Decoder>,
    current_frame_offset: usize,
    format: Box<dyn FormatReader>,
    total_duration: Option<Time>,
    buffer: SampleBuffer<f64>,
    spec: SignalSpec,
    bits_per_sample: Option<u32>,
}

impl SymphoniaDecoder {
    pub fn bits_per_sample(&self) -> Option<u32> {
        self.bits_per_sample
    }

    pub fn new(
        file: File,
        extension: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let source = SeekableFileSource::new(file);
        let mss = MediaSourceStream::new(
            Box::new(source),
            MediaSourceStreamOptions {
                buffer_len: 512 * 1024,
            },
        );

        let mut hint = Hint::new();
        if let Some(ext) = extension {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let metadata_opts: MetadataOptions = Default::default();
        let probed =
            symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts)?;

        let format = probed.format;

        let track = format
            .default_track()
            .filter(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .or_else(|| {
                format
                    .tracks()
                    .iter()
                    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            })
            .ok_or("No track with supported codec")?;

        let track_id = track.id;
        let bits_per_sample = track.codec_params.bits_per_sample;

        let mut decoder: Box<dyn Decoder> = match symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
        {
            Ok(dec) => dec,
            Err(_) if track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_OPUS => {
                Box::new(SymphoniaOpusDecoder::try_new(&track.codec_params)?)
            }
            Err(e) => return Err(Box::new(e)),
        };

        let total_duration = track
            .codec_params
            .time_base
            .zip(track.codec_params.n_frames)
            .map(|(base, frames)| base.calc_time(frames));

        let mut probed_format = format;
        let mut decode_errors = 0;
        let decoded = loop {
            let current_frame = match probed_format.next_packet() {
                Ok(packet) => packet,
                Err(e) => return Err(Box::new(e)),
            };

            if current_frame.track_id() != track_id {
                continue;
            }

            match decoder.decode(&current_frame) {
                Ok(decoded) => break decoded,
                Err(e) => {
                    decode_errors += 1;
                    if decode_errors > MAX_DECODE_RETRIES {
                        return Err(Box::new(e));
                    }
                }
            }
        };

        let spec = decoded.spec().to_owned();
        let buffer = SymphoniaDecoder::get_buffer(decoded, &spec);

        Ok(SymphoniaDecoder {
            decoder,
            current_frame_offset: 0,
            format: probed_format,
            total_duration,
            buffer,
            spec,
            bits_per_sample,
        })
    }

    fn get_buffer(decoded: AudioBufferRef, spec: &SignalSpec) -> SampleBuffer<f64> {
        let duration = units::Duration::from(decoded.capacity() as u64);
        let mut buffer = SampleBuffer::<f64>::new(duration, *spec);
        buffer.copy_interleaved_ref(decoded);
        buffer
    }

    fn refine_position(
        &mut self,
        seek_res: SeekedTo,
    ) -> Result<(), symphonia::core::errors::Error> {
        let mut samples_to_pass = seek_res.required_ts.saturating_sub(seek_res.actual_ts);
        let packet = loop {
            let candidate = self.format.next_packet()?;
            if candidate.dur() > samples_to_pass {
                break candidate;
            } else {
                samples_to_pass -= candidate.dur();
            }
        };

        let mut decoded = self.decoder.decode(&packet);
        for _ in 0..MAX_DECODE_RETRIES {
            if decoded.is_ok() {
                break;
            }
            let packet = self.format.next_packet()?;
            samples_to_pass = 0;
            decoded = self.decoder.decode(&packet);
        }

        let decoded = decoded?;
        decoded.spec().clone_into(&mut self.spec);
        self.buffer = SymphoniaDecoder::get_buffer(decoded, &self.spec);
        self.current_frame_offset = samples_to_pass as usize * self.channels() as usize;
        Ok(())
    }
}

impl Iterator for SymphoniaDecoder {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.current_frame_offset >= self.buffer.len() {
            let packet = self.format.next_packet().ok()?;
            let mut decoded = self.decoder.decode(&packet);
            for _ in 0..MAX_DECODE_RETRIES {
                if decoded.is_ok() {
                    break;
                }
                let packet = self.format.next_packet().ok()?;
                decoded = self.decoder.decode(&packet);
            }
            let decoded = decoded.ok()?;
            decoded.spec().clone_into(&mut self.spec);
            self.buffer = SymphoniaDecoder::get_buffer(decoded, &self.spec);
            self.current_frame_offset = 0;
        }

        let sample = *self.buffer.samples().get(self.current_frame_offset)?;
        self.current_frame_offset += 1;

        Some(sample as f32)
    }
}

impl Source for SymphoniaDecoder {
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        Some(self.buffer.len().saturating_sub(self.current_frame_offset))
    }

    #[inline]
    fn channels(&self) -> u16 {
        self.spec.channels.count() as u16
    }

    #[inline]
    fn sample_rate(&self) -> u32 {
        self.spec.rate
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
            .map(|Time { seconds, frac }| Duration::new(seconds, (frac * 1_000_000_000.0) as u32))
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        use symphonia::core::formats::{SeekMode, SeekTo};

        let seek_beyond_end = self
            .total_duration()
            .is_some_and(|dur| dur.saturating_sub(pos).as_millis() < 1);

        let time = if seek_beyond_end {
            let time = self.total_duration.expect("if guarantees this is Some");
            skip_back_a_tiny_bit(time)
        } else {
            pos.as_secs_f64().into()
        };

        let seek_res = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: None,
                },
            )
            .map_err(|e| rodio::source::SeekError::Other(Box::new(e)))?;

        self.refine_position(seek_res)
            .map_err(|e| rodio::source::SeekError::Other(Box::new(e)))?;

        Ok(())
    }
}

fn skip_back_a_tiny_bit(Time { seconds, frac }: Time) -> Time {
    if frac >= 0.0001 {
        Time {
            seconds,
            frac: frac - 0.0001,
        }
    } else {
        Time {
            seconds: seconds.saturating_sub(1),
            frac: 0.9999,
        }
    }
}

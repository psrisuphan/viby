use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;
use rodio::Source;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, SignalSpec};
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekedTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{self, Time};

const MAX_DECODE_RETRIES: usize = 3;

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
    buffer: SampleBuffer<f32>,
    spec: SignalSpec,
}

impl SymphoniaDecoder {
    pub fn new(file: File, extension: Option<&str>) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let source = SeekableFileSource::new(file);
        let mss = MediaSourceStream::new(Box::new(source), Default::default());
        
        let mut hint = Hint::new();
        if let Some(ext) = extension {
            hint.with_extension(ext);
        }
        
        let format_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let metadata_opts: MetadataOptions = Default::default();
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)?;
            
        let format = probed.format;
        
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("No track with supported codec")?;
            
        let track_id = track.id;
        
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())?;
            
        let total_duration = format.default_track()
            .and_then(|t| t.codec_params.time_base.zip(t.codec_params.n_frames))
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
        })
    }
    
    fn get_buffer(decoded: AudioBufferRef, spec: &SignalSpec) -> SampleBuffer<f32> {
        let duration = units::Duration::from(decoded.capacity() as u64);
        let mut buffer = SampleBuffer::<f32>::new(duration, *spec);
        buffer.copy_interleaved_ref(decoded);
        buffer
    }
    
    fn refine_position(&mut self, seek_res: SeekedTo) -> Result<(), symphonia::core::errors::Error> {
        let mut samples_to_pass = seek_res.required_ts - seek_res.actual_ts;
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
            if decoded.is_ok() { break; }
            let packet = self.format.next_packet()?;
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
                if decoded.is_ok() { break; }
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

        Some(sample)
    }
}

impl Source for SymphoniaDecoder {
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        Some(self.buffer.samples().len())
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

        let to_skip = self.current_frame_offset % self.channels() as usize;

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

        self.refine_position(seek_res).map_err(|e| rodio::source::SeekError::Other(Box::new(e)))?;
        self.current_frame_offset += to_skip;

        Ok(())
    }
}

fn skip_back_a_tiny_bit(Time { seconds, frac }: Time) -> Time {
    if frac >= 0.0001 {
        Time { seconds, frac: frac - 0.0001 }
    } else {
        Time { seconds: seconds.saturating_sub(1), frac: 0.9999 }
    }
}

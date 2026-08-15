use std::fs::File;
use std::sync::Arc;
use std::time::Duration;

use rodio::{Sink, Source};

use crate::audio::eq::{EqParams, EqSource};
use crate::audio::normalization::{NormalizationParams, NormalizationSource};
use crate::audio::output::{AudioOutput, OutputSummary};
use crate::models::Track;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DecodedTrackSpec {
    pub(crate) sample_rate: u32,
    pub(crate) channels: u32,
    pub(crate) bits_per_sample: Option<u32>,
}

pub(crate) fn normalized_seek_position(position_secs: f64, duration_secs: f64) -> Option<f64> {
    position_secs
        .is_finite()
        .then(|| position_secs.clamp(0.0, duration_secs.max(0.0)))
}

pub(crate) struct AudioSession {
    pub(crate) output: AudioOutput,
    pub(crate) sink: Sink,
}

pub(crate) const TRACK_START_FADE: Duration = Duration::from_millis(8);
pub(crate) const SHUTDOWN_FADE_STEP: Duration = Duration::from_millis(5);
pub(crate) const SHUTDOWN_FADE_STEPS: u32 = 4;

pub(crate) fn stop_audio_session(session: &mut Option<AudioSession>) {
    let Some(active) = session.as_ref() else {
        return;
    };

    if !active.sink.empty() {
        let volume = active.sink.volume();
        for step in (0..=SHUTDOWN_FADE_STEPS).rev() {
            active
                .sink
                .set_volume(volume * step as f32 / SHUTDOWN_FADE_STEPS as f32);
            if step != 0 {
                std::thread::sleep(SHUTDOWN_FADE_STEP);
            }
        }
    }

    active.sink.stop();
    std::thread::sleep(SHUTDOWN_FADE_STEP);
    let _ = session.take();
}

pub(crate) enum PreloadOutcome {
    Appended(DecodedTrackSpec),
    Skipped {
        spec: DecodedTrackSpec,
        reason: String,
    },
}

pub(crate) fn append_decoded_track(
    sink: &Sink,
    track: &Track,
    eq_params: &Arc<EqParams>,
    normalization_params: &Arc<NormalizationParams>,
    output: &OutputSummary,
) -> Result<PreloadOutcome, String> {
    let path = &track.file_path;
    let file =
        File::open(path).map_err(|e| format!("[AudioPlayer] Failed to open file '{path}': {e}"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str());
    let source = crate::audio::decoder::SymphoniaDecoder::new(file, extension)
        .map_err(|e| format!("[AudioPlayer] Failed to decode '{path}': {e}"))?;
    let spec = DecodedTrackSpec {
        sample_rate: source.sample_rate(),
        channels: source.channels() as u32,
        bits_per_sample: source.bits_per_sample(),
    };

    if output.sample_rate != spec.sample_rate || output.channels != spec.channels {
        return Ok(PreloadOutcome::Skipped {
            spec,
            reason: format!(
                "preload skipped to avoid resampling/remixing: source={} Hz/{} ch, output={} Hz/{} ch",
                spec.sample_rate, spec.channels, output.sample_rate, output.channels
            ),
        });
    }

    let normalized_source = NormalizationSource::new(
        source,
        Arc::clone(normalization_params),
        track.replaygain_track_gain,
        track.replaygain_track_peak,
    );
    let eq_source = EqSource::new(normalized_source, Arc::clone(eq_params));
    sink.append(eq_source);
    Ok(PreloadOutcome::Appended(spec))
}

pub(crate) fn open_session_at(
    path: &str,
    position_secs: f64,
    volume: f32,
    eq_params: &Arc<EqParams>,
    normalization_params: &Arc<NormalizationParams>,
    gain_db: Option<f32>,
    peak: Option<f32>,
) -> Result<(AudioSession, DecodedTrackSpec, OutputSummary, bool), String> {
    let file =
        File::open(path).map_err(|e| format!("[AudioPlayer] Failed to reopen '{path}': {e}"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str());
    let source = crate::audio::decoder::SymphoniaDecoder::new(file, extension)
        .map_err(|e| format!("[AudioPlayer] Failed to decode '{path}' during recovery: {e}"))?;
    let spec = DecodedTrackSpec {
        sample_rate: source.sample_rate(),
        channels: source.channels() as u32,
        bits_per_sample: source.bits_per_sample(),
    };

    let output = AudioOutput::open_for_source(spec.sample_rate, spec.channels)
        .map_err(|e| format!("[AudioPlayer] Failed to reopen audio output: {e}"))?;
    let output_summary = output.summary().clone();
    let sink = Sink::try_new(output.handle())
        .map_err(|e| format!("[AudioPlayer] Failed to recreate audio sink: {e}"))?;

    let position_secs = position_secs.max(0.0);
    sink.set_volume(volume);
    let normalized_source =
        NormalizationSource::new(source, Arc::clone(normalization_params), gain_db, peak);
    sink.append(EqSource::new(normalized_source, Arc::clone(eq_params)));
    if let Err(err) = sink.try_seek(Duration::from_secs_f64(position_secs)) {
        eprintln!(
            "[AudioPlayer] Native seek to {position_secs:.3}s failed: {err:?}; using sequential fallback"
        );
        return open_session_at_by_skip(
            path,
            position_secs,
            volume,
            eq_params,
            normalization_params,
            gain_db,
            peak,
        );
    }
    sink.play();

    Ok((AudioSession { output, sink }, spec, output_summary, false))
}

pub(crate) fn open_session_at_by_skip(
    path: &str,
    position_secs: f64,
    volume: f32,
    eq_params: &Arc<EqParams>,
    normalization_params: &Arc<NormalizationParams>,
    gain_db: Option<f32>,
    peak: Option<f32>,
) -> Result<(AudioSession, DecodedTrackSpec, OutputSummary, bool), String> {
    let file =
        File::open(path).map_err(|e| format!("[AudioPlayer] Failed to reopen '{path}': {e}"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str());
    let source = crate::audio::decoder::SymphoniaDecoder::new(file, extension).map_err(|e| {
        format!("[AudioPlayer] Failed to decode '{path}' during fallback seek: {e}")
    })?;
    let spec = DecodedTrackSpec {
        sample_rate: source.sample_rate(),
        channels: source.channels() as u32,
        bits_per_sample: source.bits_per_sample(),
    };
    let output = AudioOutput::open_for_source(spec.sample_rate, spec.channels)
        .map_err(|e| format!("[AudioPlayer] Failed to reopen audio output: {e}"))?;
    let output_summary = output.summary().clone();
    let sink = Sink::try_new(output.handle())
        .map_err(|e| format!("[AudioPlayer] Failed to recreate audio sink: {e}"))?;

    sink.set_volume(volume);
    let source = source.skip_duration(Duration::from_secs_f64(position_secs.max(0.0)));
    let normalized_source =
        NormalizationSource::new(source, Arc::clone(normalization_params), gain_db, peak);
    sink.append(EqSource::new(normalized_source, Arc::clone(eq_params)));
    sink.play();

    Ok((AudioSession { output, sink }, spec, output_summary, true))
}

pub(crate) fn reopen_sink_at(
    output: &mut AudioOutput,
    sink: &mut Sink,
    path: &str,
    position_secs: f64,
    volume: f32,
    eq_params: &Arc<EqParams>,
    normalization_params: &Arc<NormalizationParams>,
    gain_db: Option<f32>,
    peak: Option<f32>,
) -> Result<(DecodedTrackSpec, OutputSummary, bool), String> {
    let (new_session, spec, output_summary, used_fallback) = open_session_at(
        path,
        position_secs,
        volume,
        eq_params,
        normalization_params,
        gain_db,
        peak,
    )?;

    sink.stop();
    *output = new_session.output;
    *sink = new_session.sink;
    Ok((spec, output_summary, used_fallback))
}

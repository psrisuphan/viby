use std::fs::File;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::{Sink, Source};
use tauri::{AppHandle, Emitter, Manager};

use crate::FrontendVisible;
use crate::audio::eq::{EqParams, EqSource};
use crate::audio::media::mpris_cover_url;
use crate::audio::normalization::{NormalizationParams, NormalizationSource};
use crate::audio::output::AudioOutput;
use crate::audio::preferences::PlaybackPreferencesStore;
use crate::audio::queue::QueueState;
use crate::audio::session::{
    AudioSession, DecodedTrackSpec, PreloadOutcome, TRACK_START_FADE, append_decoded_track,
    normalized_seek_position, open_session_at, reopen_sink_at, stop_audio_session,
};
use crate::commands::queue_events::{emit_queue_position_changed, queue_position_payload};
use crate::library::database::Database;
use crate::models::PlaybackProgressPayload;

use super::player::{
    AudioCommand, AudioPlayer, AudioPlayerInner, PlaybackSignature, TrackedMutex,
    advance_progress_generation, advance_progress_sequence, apply_failed_load,
    apply_volume_transition, audio_command_timeout, audio_output_should_release, debug_log_event,
    emit_playback_state, media_progress_due, next_preload_candidate, playback_debug_enabled,
    playback_progress_due, playback_signature, playback_state_from_inner, publish_command_state,
    record_play, restore_volume_state, update_output_state,
};

const PLAYBACK_STATE_MIN_INTERVAL: Duration = Duration::from_millis(50);

fn pending_state_emit_due(pending: bool, last_emit: Instant, now: Instant) -> bool {
    pending && now.duration_since(last_emit) >= PLAYBACK_STATE_MIN_INTERVAL
}

fn progress_publication_due(
    is_playing: bool,
    has_session: bool,
    last_progress_event: Instant,
    now: Instant,
) -> bool {
    has_session && playback_progress_due(last_progress_event, now, is_playing)
}

fn update_position_from_sink(state: &mut AudioPlayerInner, sink_position_secs: f64, now: Instant) {
    if let Some(guard_until) = state.seek_guard_until {
        if now >= guard_until {
            state.seek_guard_until = None;
            state.position_secs = sink_position_secs - state.sink_baseline_secs;
        }
    } else {
        state.position_secs =
            state.seek_position_offset + (sink_position_secs - state.sink_baseline_secs);
    }
}

fn publish_progress_update(
    app_handle: &AppHandle,
    progress: &PlaybackProgressPayload,
    last_media_progress_update: &mut Option<Instant>,
    now: Instant,
) {
    if let Err(error) = app_handle.emit("playback-progress", progress) {
        eprintln!("[AudioPlayer] Failed to emit playback-progress: {error}");
    }

    if media_progress_due(*last_media_progress_update, now, false)
        && let Some(controls_state) = app_handle.try_state::<Mutex<souvlaki::MediaControls>>()
        && let Ok(mut controls) = controls_state.lock()
    {
        let playback = souvlaki::MediaPlayback::Playing {
            progress: Some(souvlaki::MediaPosition(Duration::from_secs_f64(
                progress.position_secs.max(0.0),
            ))),
        };
        if let Err(error) = controls.set_playback(playback) {
            eprintln!("[AudioPlayer] Failed to update media playback state: {error}");
        }
        *last_media_progress_update = Some(now);
    }
}

pub(crate) fn run_audio_thread(
    app_handle: AppHandle,
    rx: Receiver<AudioCommand>,
    inner_clone: Arc<TrackedMutex<AudioPlayerInner>>,
    eq_params_thread: Arc<EqParams>,
    normalization_params_thread: Arc<NormalizationParams>,
    preferences: PlaybackPreferencesStore,
) {
    // A paused cpal/rodio stream still runs the hardware callback. Keep the audio
    // device closed until playback starts, and release it after stop/end.
    let mut session: Option<AudioSession> = None;
    let mut release_after_track_end = false;
    let mut paused_since: Option<Instant> = None;

    // Track the last emitted signature to suppress idle no-op emits.
    // (is_playing, track_id, duration, volume)
    let mut last_emit_sig: Option<PlaybackSignature> = None;
    let mut last_progress_emit = Instant::now();
    let mut last_progress_event = Instant::now();
    let mut pending_state_emit = false;
    let mut last_media_progress_update: Option<Instant> = None;
    let mut last_sink_pos = 0.0;
    let mut stalled_since: Option<Instant> = None;
    let mut last_recovery_attempt: Option<Instant> = None;

    // Main loop — wait for commands and handle them
    // `recv_timeout` waits for a message OR times out, which lets us
    // periodically emit progress updates even when no commands arrive.
    'audio_loop: loop {
        if pending_state_emit_due(pending_state_emit, last_progress_emit, Instant::now()) {
            let pending = inner_clone.lock().ok().map(|mut state| {
                advance_progress_sequence(&mut state);
                (
                    playback_state_from_inner(&state, &eq_params_thread),
                    playback_signature(&state),
                )
            });
            if let Some((playback_state, signature)) = pending {
                let now = publish_command_state(&app_handle, &playback_state);
                last_emit_sig = Some(signature);
                last_progress_emit = now;
                last_progress_event = now;
                last_media_progress_update = Some(now);
                pending_state_emit = false;
            }
        }

        // While playing, wake for progress and end-of-track checks. Paused or idle
        // playback has no time-based work, so block until the next command.
        let (is_playing, has_current_track) = inner_clone
            .lock()
            .map(|state| (state.is_playing, state.current_track.is_some()))
            .unwrap_or((false, false));
        if audio_output_should_release(has_current_track, release_after_track_end) {
            if session.take().is_some()
                && let Ok(mut state) = inner_clone.lock()
            {
                state.output_sample_rate = None;
                state.output_channels = None;
                state.output_sample_format = None;
                state.output_fallback_reason = None;
            }
            release_after_track_end = false;
            paused_since = None;
        }
        let now = Instant::now();
        // Check deadlines before waiting for another command. A continuously
        // ready receiver must not starve the 10 Hz progress stream.
        if progress_publication_due(is_playing, session.is_some(), last_progress_event, now)
            && let Some(active) = session.as_ref()
        {
            let progress = inner_clone.lock().ok().and_then(|mut state| {
                if !state.is_playing {
                    return None;
                }
                update_position_from_sink(&mut state, active.sink.get_pos().as_secs_f64(), now);
                advance_progress_sequence(&mut state);
                Some(PlaybackProgressPayload {
                    position_secs: state.position_secs,
                    duration_secs: state.duration_secs,
                    generation: state.progress_generation,
                    sequence: state.progress_sequence,
                })
            });
            if let Some(progress) = progress {
                publish_progress_update(
                    &app_handle,
                    &progress,
                    &mut last_media_progress_update,
                    now,
                );
                last_progress_event = now;
            }
        }
        let normal_timeout = audio_command_timeout(is_playing, paused_since, now);
        let timeout = if pending_state_emit {
            let coalesce_delay =
                PLAYBACK_STATE_MIN_INTERVAL.saturating_sub(now.duration_since(last_progress_emit));
            Some(normal_timeout.map_or(coalesce_delay, |normal| normal.min(coalesce_delay)))
        } else {
            normal_timeout
        };
        let command = match timeout {
            Some(interval) => rx.recv_timeout(interval),
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        if !is_playing
            && !pending_state_emit
            && matches!(command, Err(mpsc::RecvTimeoutError::Timeout))
        {
            if session.take().is_some()
                && let Ok(mut state) = inner_clone.lock()
            {
                state.output_sample_rate = None;
                state.output_channels = None;
                state.output_sample_format = None;
                state.output_fallback_reason = None;
            }
            paused_since = None;
            continue;
        }
        match command {
            Ok(command) => match command {
                AudioCommand::LoadTrack(mut path, mut track) => {
                    let mut skipped_loads = 0usize;
                    let mut play_after_load = true;
                    let mut seek_after_load = None;
                    let mut pending_volume: Option<f32> = None;

                    loop {
                        match rx.try_recv() {
                            Ok(AudioCommand::LoadTrack(next_path, next_track)) => {
                                path = next_path;
                                track = next_track;
                                skipped_loads += 1;
                            }
                            Ok(command @ AudioCommand::SetVolume(_))
                            | Ok(command @ AudioCommand::ToggleMute)
                            | Ok(command @ AudioCommand::RestoreVolumePreferences(_, _)) => {
                                // Defer volume change — will be applied to the new sink
                                let restore_ack = match &command {
                                    AudioCommand::RestoreVolumePreferences(_, done) => {
                                        Some(done.clone())
                                    }
                                    _ => None,
                                };
                                let applied = if let Ok(mut state) = inner_clone.lock() {
                                    if let Some(volume) =
                                        apply_volume_transition(&mut state, &command, &preferences)
                                    {
                                        pending_volume = Some(volume);
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                };
                                if let Some(done) = restore_ack {
                                    let result = if applied {
                                        Ok(())
                                    } else {
                                        Err("Could not apply playback preferences".to_string())
                                    };
                                    let _ = done.send(result);
                                }
                            }
                            Ok(AudioCommand::Pause) => {
                                play_after_load = false;
                            }
                            Ok(AudioCommand::Resume) => {
                                play_after_load = true;
                            }
                            Ok(AudioCommand::Seek(position_secs)) => {
                                seek_after_load = Some(position_secs);
                            }
                            Ok(AudioCommand::Stop) => {
                                if let Some(active) = session.as_mut() {
                                    active.sink.pause();
                                    active.sink.clear();
                                }
                                if let Ok(mut state) = inner_clone.lock() {
                                    advance_progress_generation(&mut state);
                                    state.is_playing = false;
                                    state.current_track = None;
                                    state.current_path = None;
                                    state.queued_track = None;
                                    state.queued_path = None;
                                    state.position_secs = 0.0;
                                    state.duration_secs = 0.0;
                                    state.sample_rate = 48_000;
                                    state.channels = 2;
                                    state.bits_per_sample = None;
                                    state.seek_position_offset = 0.0;
                                    state.seek_guard_until = None;
                                }
                                pending_state_emit = true;
                                continue 'audio_loop;
                            }
                            Ok(AudioCommand::Shutdown(done)) => {
                                stop_audio_session(&mut session);
                                let _ = done.send(());
                                break 'audio_loop;
                            }
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => break 'audio_loop,
                        }
                    }

                    if skipped_loads > 0 && playback_debug_enabled() {
                        eprintln!(
                            "[AudioPlayer] Coalesced {skipped_loads} queued track load(s); decoding latest skip target."
                        );
                    }

                    let load_start = Instant::now();
                    debug_log_event(
                        "audio_thread",
                        &format!("load_track processing path={}", path),
                    );

                    debug_log_event("audio_thread", "Opening file");
                    let file = match File::open(&path) {
                        Ok(f) => f,
                        Err(e) => {
                            debug_log_event("audio_thread", &format!("Failed to open file: {e}"));
                            eprintln!("[AudioPlayer] Failed to open file '{}': {}", path, e);
                            stop_audio_session(&mut session);
                            paused_since = None;
                            let failed_state = inner_clone.lock().ok().map(|mut state| {
                                apply_failed_load(&mut state);
                            });
                            pending_state_emit |= failed_state.is_some();
                            continue;
                        }
                    };

                    let extension = std::path::Path::new(&path)
                        .extension()
                        .and_then(|ext| ext.to_str());
                    debug_log_event("audio_thread", "Initializing SymphoniaDecoder");
                    let source = match crate::audio::decoder::SymphoniaDecoder::new(file, extension)
                    {
                        Ok(s) => s,
                        Err(e) => {
                            debug_log_event("audio_thread", &format!("Failed to decode file: {e}"));
                            eprintln!("[AudioPlayer] Failed to decode '{}': {}", path, e);
                            stop_audio_session(&mut session);
                            paused_since = None;
                            let failed_state = inner_clone.lock().ok().map(|mut state| {
                                apply_failed_load(&mut state);
                            });
                            pending_state_emit |= failed_state.is_some();
                            continue;
                        }
                    };
                    debug_log_event("audio_thread", "SymphoniaDecoder initialized successfully");

                    let source_spec = DecodedTrackSpec {
                        sample_rate: source.sample_rate(),
                        channels: source.channels() as u32,
                        bits_per_sample: source.bits_per_sample(),
                    };
                    debug_log_event(
                        "audio_thread",
                        &format!(
                            "Track specs: sample_rate={}, channels={}, bits_per_sample={:?}",
                            source_spec.sample_rate,
                            source_spec.channels,
                            source_spec.bits_per_sample
                        ),
                    );

                    let reused_output = session.is_some();
                    let mut output = match session.take() {
                        Some(active) => {
                            let AudioSession { output, sink } = active;
                            sink.stop();
                            drop(sink);
                            output
                        }
                        None => match AudioOutput::open_for_source(
                            source_spec.sample_rate,
                            source_spec.channels,
                        ) {
                            Ok(new_output) => {
                                if let Some(reason) = &new_output.summary().fallback_reason {
                                    eprintln!("[AudioPlayer] {reason}");
                                }
                                new_output
                            }
                            Err(err) => {
                                eprintln!(
                                    "[AudioPlayer] Failed to open output for {} Hz / {} ch: {}",
                                    source_spec.sample_rate, source_spec.channels, err
                                );
                                continue;
                            }
                        },
                    };
                    if output.is_native_for(source_spec.sample_rate, source_spec.channels) {
                        output.clear_fallback_if_native_for(
                            source_spec.sample_rate,
                            source_spec.channels,
                        );
                    } else if reused_output {
                        debug_log_event(
                            "audio_thread",
                            &format!(
                                "Recreating output for source: old={} Hz/{} ch, new={} Hz/{} ch",
                                output.summary().sample_rate,
                                output.summary().channels,
                                source_spec.sample_rate,
                                source_spec.channels
                            ),
                        );
                        match AudioOutput::open_for_source(
                            source_spec.sample_rate,
                            source_spec.channels,
                        ) {
                            Ok(new_output) => output = new_output,
                            Err(err) => eprintln!(
                                "[AudioPlayer] Failed to reopen output for {} Hz / {} ch: {}",
                                source_spec.sample_rate, source_spec.channels, err
                            ),
                        }
                    }
                    let mut output_summary = output.summary().clone();

                    // Create a fresh sink for the new track
                    debug_log_event("audio_thread", "Creating new Sink for track");
                    let mut sink = match Sink::try_new(output.handle()) {
                        Ok(s) => s,
                        Err(e) => {
                            debug_log_event("audio_thread", &format!("Failed to create sink: {e}"));
                            eprintln!("[AudioPlayer] Failed to create sink: {e}");
                            continue;
                        }
                    };
                    sink.pause();

                    // Apply volume to the new sink (deferred from coalescing loop,
                    // or restored from shared state for continuity)
                    if let Some(vol) = pending_volume {
                        sink.set_volume(vol);
                    } else if let Ok(state) = inner_clone.lock() {
                        sink.set_volume(state.volume);
                    }

                    debug_log_event("audio_thread", "Creating EqSource and appending to sink");
                    let normalized_source = NormalizationSource::new(
                        source,
                        Arc::clone(&normalization_params_thread),
                        track.replaygain_track_gain,
                        track.replaygain_track_peak,
                    );
                    let eq_source = EqSource::new(normalized_source, Arc::clone(&eq_params_thread));
                    sink.append(eq_source.fade_in(TRACK_START_FADE));
                    debug_log_event("audio_thread", "Source appended to sink");

                    let mut seek_used_fallback = false;
                    if let Some(position_secs) = seek_after_load {
                        let duration = Duration::from_secs_f64(position_secs.max(0.0));
                        debug_log_event(
                            "audio_thread",
                            &format!("Performing initial seek to {}s", position_secs),
                        );
                        if let Err(err) = sink.try_seek(duration) {
                            debug_log_event(
                                "audio_thread",
                                &format!("Initial seek failed: {:?}", err),
                            );
                            eprintln!(
                                "[AudioPlayer] Initial seek to {position_secs:.3}s failed after load: {err:?}; using fallback"
                            );
                            match open_session_at(
                                &path,
                                position_secs,
                                pending_volume.as_ref().copied().unwrap_or_else(|| {
                                    inner_clone.lock().map(|state| state.volume).unwrap_or(1.0)
                                }),
                                &eq_params_thread,
                                &normalization_params_thread,
                                track.replaygain_track_gain,
                                track.replaygain_track_peak,
                            ) {
                                Ok((new_session, _, reopened_summary, used_fallback)) => {
                                    sink.stop();
                                    output = new_session.output;
                                    sink = new_session.sink;
                                    output_summary = reopened_summary;
                                    seek_used_fallback = used_fallback;
                                }
                                Err(fallback_err) => {
                                    eprintln!(
                                        "[AudioPlayer] Initial fallback seek to {position_secs:.3}s failed: {fallback_err}"
                                    );
                                    seek_after_load = None;
                                }
                            }
                        }
                    }
                    if play_after_load {
                        debug_log_event("audio_thread", "Playing sink");
                        sink.play();
                    } else {
                        debug_log_event("audio_thread", "Pausing sink");
                        sink.pause();
                    }

                    // Capture the cumulative sink position for a normally queued track.
                    // A seeked source reports an absolute track position, so its baseline
                    // must stay at zero.
                    let current_baseline = if seek_after_load.is_some() {
                        0.0
                    } else {
                        sink.get_pos().as_secs_f64()
                    };

                    // Update shared state
                    if let Ok(mut state) = inner_clone.lock() {
                        state.is_playing = play_after_load;
                        state.current_track = Some(track.as_ref().clone());
                        state.duration_secs = track.duration_secs;
                        state.sink_baseline_secs = current_baseline;
                        state.position_secs = seek_after_load.unwrap_or(0.0);
                        state.current_path = Some(path.clone());
                        state.queued_track = None;
                        state.queued_path = None;
                        state.sample_rate = source_spec.sample_rate;
                        state.channels = source_spec.channels;
                        state.bits_per_sample = source_spec.bits_per_sample;
                        update_output_state(&mut state, &output_summary);
                        state.seek_position_offset = seek_after_load
                            .filter(|_| seek_used_fallback)
                            .unwrap_or(0.0);
                        state.seek_guard_until = seek_after_load
                            .filter(|_| !seek_used_fallback)
                            .map(|_| Instant::now() + Duration::from_millis(50));
                    }

                    if playback_debug_enabled() {
                        eprintln!(
                            "[AudioPlayer] Loaded '{}' in {:?}.",
                            track.title,
                            load_start.elapsed()
                        );
                    }

                    if let Some(next_track) = next_preload_candidate(&app_handle) {
                        let preload_start = Instant::now();
                        let next_path = next_track.file_path.clone();
                        match append_decoded_track(
                            &sink,
                            &next_track,
                            &eq_params_thread,
                            &normalization_params_thread,
                            &output_summary,
                        ) {
                            Ok(PreloadOutcome::Appended(spec)) => {
                                if let Ok(mut state) = inner_clone.lock() {
                                    state.queued_path = Some(next_path);
                                    state.queued_track = Some(next_track);
                                    state.queued_sample_rate = Some(spec.sample_rate);
                                    state.queued_channels = Some(spec.channels);
                                    state.queued_bits_per_sample = spec.bits_per_sample;
                                }
                                if playback_debug_enabled() {
                                    eprintln!(
                                        "[AudioPlayer] Preloaded next track in {:?}.",
                                        preload_start.elapsed()
                                    );
                                }
                            }
                            Ok(PreloadOutcome::Skipped { spec, reason }) => {
                                debug_log_event(
                                    "audio_thread",
                                    &format!(
                                        "{reason}; next specs={} Hz/{} ch/{:?}",
                                        spec.sample_rate, spec.channels, spec.bits_per_sample
                                    ),
                                );
                                if playback_debug_enabled() {
                                    eprintln!("[AudioPlayer] {reason}");
                                }
                            }
                            Err(err) => eprintln!("{err}"),
                        }
                    }
                    session = Some(AudioSession { output, sink });
                    paused_since = (!play_after_load).then(Instant::now);
                    pending_state_emit = true;
                }

                AudioCommand::Pause => {
                    let paused_sink_position = session.as_mut().map(|active| {
                        active.sink.pause();
                        paused_since = Some(Instant::now());
                        active.sink.get_pos().as_secs_f64()
                    });
                    let command_update = if let Ok(mut state) = inner_clone.lock() {
                        state.is_playing = false;
                        if let Some(sink_position) = paused_sink_position {
                            state.position_secs = state.seek_position_offset
                                + (sink_position - state.sink_baseline_secs);
                        }
                        Some(())
                    } else {
                        None
                    };
                    if command_update.is_some() {
                        pending_state_emit = true;
                    }
                }

                AudioCommand::Resume => {
                    paused_since = None;
                    let mut restored_session = false;
                    if session.is_none() {
                        let resume_request = inner_clone.lock().ok().and_then(|state| {
                            let track = state.current_track.as_ref()?;
                            Some((
                                state.current_path.clone()?,
                                state.position_secs,
                                state.volume,
                                track.replaygain_track_gain,
                                track.replaygain_track_peak,
                            ))
                        });
                        if let Some((path, position, volume, gain, peak)) = resume_request {
                            match open_session_at(
                                &path,
                                position,
                                volume,
                                &eq_params_thread,
                                &normalization_params_thread,
                                gain,
                                peak,
                            ) {
                                Ok((new_session, spec, output_summary, used_fallback)) => {
                                    if let Ok(mut state) = inner_clone.lock() {
                                        state.position_secs = position;
                                        state.sink_baseline_secs = 0.0;
                                        state.seek_position_offset =
                                            if used_fallback { position } else { 0.0 };
                                        state.seek_guard_until = (!used_fallback)
                                            .then(|| Instant::now() + Duration::from_millis(50));
                                        state.sample_rate = spec.sample_rate;
                                        state.channels = spec.channels;
                                        state.bits_per_sample = spec.bits_per_sample;
                                        state.queued_track = None;
                                        state.queued_path = None;
                                        state.queued_sample_rate = None;
                                        state.queued_channels = None;
                                        state.queued_bits_per_sample = None;
                                        update_output_state(&mut state, &output_summary);
                                    }
                                    session = Some(new_session);
                                    restored_session = true;
                                }
                                Err(err) => eprintln!("{err}"),
                            }
                        }
                    }
                    if restored_session
                        && let (Some(active), Some(next_track)) =
                            (session.as_ref(), next_preload_candidate(&app_handle))
                    {
                        let next_path = next_track.file_path.clone();
                        if let Ok(PreloadOutcome::Appended(spec)) = append_decoded_track(
                            &active.sink,
                            &next_track,
                            &eq_params_thread,
                            &normalization_params_thread,
                            active.output.summary(),
                        ) && let Ok(mut state) = inner_clone.lock()
                        {
                            state.queued_path = Some(next_path);
                            state.queued_track = Some(next_track);
                            state.queued_sample_rate = Some(spec.sample_rate);
                            state.queued_channels = Some(spec.channels);
                            state.queued_bits_per_sample = spec.bits_per_sample;
                        }
                    }
                    if let Some(active) = session.as_mut() {
                        active.sink.play();
                        if let Ok(mut state) = inner_clone.lock() {
                            state.is_playing = true;
                        }
                        pending_state_emit = true;
                    }
                }

                AudioCommand::Stop => {
                    paused_since = None;
                    if let Some(active) = session.as_mut() {
                        active.sink.pause();
                        active.sink.clear();
                    }
                    let command_update = if let Ok(mut state) = inner_clone.lock() {
                        advance_progress_generation(&mut state);
                        state.is_playing = false;
                        state.current_track = None;
                        state.current_path = None;
                        state.queued_track = None;
                        state.queued_path = None;
                        state.position_secs = 0.0;
                        state.duration_secs = 0.0;
                        state.sample_rate = 48_000;
                        state.channels = 2;
                        state.bits_per_sample = None;
                        state.seek_position_offset = 0.0;
                        state.sink_baseline_secs = 0.0;
                        state.seek_guard_until = None;
                        Some(())
                    } else {
                        None
                    };
                    if command_update.is_some() {
                        pending_state_emit = true;
                    }
                }

                AudioCommand::Seek(position_secs) => {
                    let Some((duration_secs, was_playing, fallback_request)) =
                        inner_clone.lock().ok().map(|state| {
                            (
                                state.duration_secs,
                                state.is_playing,
                                state.current_path.clone().map(|path| {
                                    let track = state.current_track.as_ref();
                                    (
                                        path,
                                        state.volume,
                                        track.and_then(|track| track.replaygain_track_gain),
                                        track.and_then(|track| track.replaygain_track_peak),
                                    )
                                }),
                            )
                        })
                    else {
                        continue;
                    };

                    let Some(position_secs) =
                        normalized_seek_position(position_secs, duration_secs)
                    else {
                        continue;
                    };

                    let had_session = session.is_some();
                    let mut seek_applied = false;
                    if let Some(active) = session.as_mut() {
                        if let Err(err) =
                            active.sink.try_seek(Duration::from_secs_f64(position_secs))
                        {
                            eprintln!(
                                "[AudioPlayer] Fast seek to {position_secs:.3}s failed: {err:?}; using fallback"
                            );
                            if let Some((path, volume, gain_db, peak)) = fallback_request {
                                match reopen_sink_at(
                                    &mut active.output,
                                    &mut active.sink,
                                    &path,
                                    position_secs,
                                    volume,
                                    &eq_params_thread,
                                    &normalization_params_thread,
                                    gain_db,
                                    peak,
                                ) {
                                    Ok((spec, output_summary, used_fallback)) => {
                                        if !was_playing {
                                            active.sink.pause();
                                        }
                                        if let Ok(mut state) = inner_clone.lock() {
                                            state.position_secs = position_secs;
                                            state.sink_baseline_secs = 0.0;
                                            state.seek_position_offset =
                                                if used_fallback { position_secs } else { 0.0 };
                                            state.seek_guard_until =
                                                (was_playing && !used_fallback).then(|| {
                                                    Instant::now() + Duration::from_millis(50)
                                                });
                                            state.sample_rate = spec.sample_rate;
                                            state.channels = spec.channels;
                                            state.bits_per_sample = spec.bits_per_sample;
                                            state.queued_track = None;
                                            state.queued_path = None;
                                            state.queued_sample_rate = None;
                                            state.queued_channels = None;
                                            state.queued_bits_per_sample = None;
                                            update_output_state(&mut state, &output_summary);
                                        }
                                        seek_applied = true;
                                    }
                                    Err(fallback_err) => eprintln!(
                                        "[AudioPlayer] Fallback seek to {position_secs:.3}s failed: {fallback_err}"
                                    ),
                                }
                            }
                        } else {
                            if let Ok(mut state) = inner_clone.lock() {
                                state.position_secs = position_secs;
                                state.seek_position_offset = 0.0;
                                state.seek_guard_until =
                                    was_playing.then(|| Instant::now() + Duration::from_millis(50));
                            }
                            seek_applied = true;
                        }
                    }

                    // When the output was released during a long pause, keep the new
                    // position in shared state. Resume will reopen the decoder there.
                    if !had_session
                        && let Ok(mut state) = inner_clone.lock()
                        && state.current_track.is_some()
                    {
                        state.position_secs = position_secs;
                        state.seek_position_offset = 0.0;
                        state.seek_guard_until = None;
                        seek_applied = true;
                    }

                    if seek_applied {
                        if let Ok(mut state) = inner_clone.lock() {
                            advance_progress_generation(&mut state);
                        }
                        pending_state_emit = true;
                    }
                }

                command @ (AudioCommand::SetVolume(_) | AudioCommand::ToggleMute) => {
                    if let Ok(mut state) = inner_clone.lock()
                        && let Some(volume) =
                            apply_volume_transition(&mut state, &command, &preferences)
                    {
                        if let Some(active) = session.as_mut() {
                            active.sink.set_volume(volume);
                        }
                        pending_state_emit = true;
                    }
                }

                AudioCommand::RestoreVolumePreferences(preferences_snapshot, done) => {
                    let command_update = inner_clone.lock().ok().map(|mut state| {
                        let volume = restore_volume_state(&mut state, &preferences_snapshot);
                        preferences.update_volume(
                            state.volume,
                            state.is_muted,
                            state.previous_volume,
                        );
                        if let Some(active) = session.as_mut() {
                            active.sink.set_volume(volume);
                        }
                        (
                            playback_state_from_inner(&state, &eq_params_thread),
                            playback_signature(&state),
                        )
                    });
                    if let Some((mut playback_state, signature)) = command_update {
                        emit_playback_state(&app_handle, &mut playback_state);
                        last_emit_sig = Some(signature);
                        last_progress_emit = Instant::now();
                        let _ = done.send(Ok(()));
                    } else {
                        let _ = done.send(Err("Could not apply playback preferences".to_string()));
                    }
                }

                AudioCommand::Shutdown(done) => {
                    stop_audio_session(&mut session);
                    let _ = done.send(());
                    break;
                }
            },

            // Timeout — no command received in 50ms
            // This is normal — we use this to update progress
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending_state_emit && session.is_none() {
                    let command_update = inner_clone.lock().ok().map(|mut state| {
                        advance_progress_sequence(&mut state);
                        (
                            playback_state_from_inner(&state, &eq_params_thread),
                            playback_signature(&state),
                        )
                    });
                    if let Some((playback_state, signature)) = command_update {
                        let now = publish_command_state(&app_handle, &playback_state);
                        last_emit_sig = Some(signature);
                        last_progress_emit = now;
                        last_progress_event = now;
                        last_media_progress_update = Some(now);
                        pending_state_emit = false;
                    }
                }
                let Some(active) = session.as_mut() else {
                    continue;
                };
                let AudioSession { output, sink } = active;
                let mut should_preload_after_promotion = false;
                let mut promoted_track_id: Option<String> = None;
                let sink_pos = sink.get_pos().as_secs_f64();
                let mut should_emit_ended = false;
                let mut recovery_request = None;
                let now = Instant::now();

                if let Ok(state) = inner_clone.lock() {
                    let stuck = state.is_playing
                        && state.current_path.is_some()
                        && !sink.empty()
                        && sink_pos + 0.001 >= last_sink_pos
                        && sink_pos <= last_sink_pos + 0.001
                        && state.position_secs + 1.0 < state.duration_secs;

                    if stuck {
                        let since = stalled_since.get_or_insert(now);
                        let retry_due = last_recovery_attempt.is_none_or(|attempt| {
                            now.duration_since(attempt) >= Duration::from_secs(5)
                        });
                        if retry_due && now.duration_since(*since) >= Duration::from_secs(2) {
                            recovery_request = state.current_path.as_ref().map(|path| {
                                let gain = state
                                    .current_track
                                    .as_ref()
                                    .and_then(|track| track.replaygain_track_gain);
                                let peak = state
                                    .current_track
                                    .as_ref()
                                    .and_then(|track| track.replaygain_track_peak);
                                (path.clone(), state.position_secs, state.volume, gain, peak)
                            });
                            last_recovery_attempt = Some(now);
                        }
                    } else {
                        stalled_since = None;
                        last_sink_pos = sink_pos;
                    }
                }

                if let Some((path, position_secs, volume, gain_db, peak)) = recovery_request {
                    // ponytail: watchdog-based recovery; replace with cpal device events if rodio exposes them here.
                    match reopen_sink_at(
                        output,
                        sink,
                        &path,
                        position_secs,
                        volume,
                        &eq_params_thread,
                        &normalization_params_thread,
                        gain_db,
                        peak,
                    ) {
                        Ok((spec, output_summary, used_fallback)) => {
                            if playback_debug_enabled() {
                                eprintln!(
                                    "[AudioPlayer] Recovered stalled audio output at {position_secs:.3}s."
                                );
                            }
                            last_sink_pos = if used_fallback { 0.0 } else { position_secs };
                            stalled_since = None;
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = true;
                                state.position_secs = position_secs;
                                state.sink_baseline_secs = 0.0;
                                state.seek_position_offset =
                                    if used_fallback { position_secs } else { 0.0 };
                                state.seek_guard_until = (!used_fallback)
                                    .then(|| Instant::now() + Duration::from_millis(50));
                                state.sample_rate = spec.sample_rate;
                                state.channels = spec.channels;
                                state.bits_per_sample = spec.bits_per_sample;
                                state.queued_track = None;
                                state.queued_path = None;
                                update_output_state(&mut state, &output_summary);
                            }
                        }
                        Err(err) => eprintln!("{err}"),
                    }
                }

                let queued_track_at_handoff = if sink.len() == 1 {
                    inner_clone
                        .lock()
                        .ok()
                        .and_then(|state| state.is_playing.then(|| state.queued_track.clone()))
                        .flatten()
                } else {
                    None
                };

                if let Some(queued_track) = queued_track_at_handoff {
                    let expected_track = next_preload_candidate(&app_handle);
                    let queued_still_matches = expected_track
                        .as_ref()
                        .is_some_and(|expected| expected.id == queued_track.id);

                    if queued_still_matches {
                        if let Ok(mut state) = inner_clone.lock()
                            && state.is_playing
                            && state
                                .queued_track
                                .as_ref()
                                .is_some_and(|track| track.id == queued_track.id)
                            && let Some(next_track) = state.queued_track.take()
                        {
                            advance_progress_generation(&mut state);
                            let next_path = state.queued_path.take();
                            state.current_path = next_path;
                            state.duration_secs = next_track.duration_secs;
                            state.current_track = Some(next_track.clone());
                            state.sample_rate = state.queued_sample_rate.take().unwrap_or(48_000);
                            state.channels = state.queued_channels.take().unwrap_or(2);
                            state.bits_per_sample = state.queued_bits_per_sample.take();

                            // Capture exact sink position at promotion.
                            // sink.get_pos() is cumulative; this baseline is subtracted
                            // from future sink.get_pos() calls to get relative position.
                            state.sink_baseline_secs = sink_pos;
                            state.position_secs = 0.0;
                            state.seek_position_offset = 0.0;
                            state.seek_guard_until = None;

                            if playback_debug_enabled() {
                                eprintln!(
                                    "[AudioPlayer] Gapless promotion: '{}' (baseline={:.3}s, sink_len={})",
                                    next_track.title,
                                    state.sink_baseline_secs,
                                    sink.len()
                                );
                            }

                            promoted_track_id = Some(next_track.id);
                            should_preload_after_promotion = true;

                            pending_state_emit = true;
                        }
                    } else {
                        if playback_debug_enabled() {
                            eprintln!(
                                "[AudioPlayer] Discarding stale preload '{}' after queue mode change.",
                                queued_track.title
                            );
                        }
                        sink.stop();
                        if let Ok(mut state) = inner_clone.lock()
                            && state.is_playing
                            && state
                                .queued_track
                                .as_ref()
                                .is_some_and(|track| track.id == queued_track.id)
                        {
                            state.is_playing = false;
                            state.position_secs = state.duration_secs;
                            state.queued_track = None;
                            state.queued_path = None;
                            state.queued_sample_rate = None;
                            state.queued_channels = None;
                            state.queued_bits_per_sample = None;
                            should_emit_ended = true;
                        }
                    }
                }

                if let Some(track_id) = promoted_track_id {
                    record_play(&app_handle, &track_id);
                    let queue_position = app_handle.try_state::<QueueState>().and_then(|queue| {
                        queue.0.lock().ok().map(|mut q| {
                            let _ = q.next(false);
                            queue_position_payload(&q)
                        })
                    });
                    if let Some(payload) = queue_position {
                        emit_queue_position_changed(&app_handle, &payload);
                    }
                }

                if should_preload_after_promotion
                    && let Some(next_track) = next_preload_candidate(&app_handle)
                {
                    let next_path = next_track.file_path.clone();
                    match append_decoded_track(
                        sink,
                        &next_track,
                        &eq_params_thread,
                        &normalization_params_thread,
                        output.summary(),
                    ) {
                        Ok(PreloadOutcome::Appended(spec)) => {
                            if let Ok(mut state) = inner_clone.lock() {
                                state.queued_path = Some(next_path);
                                state.queued_track = Some(next_track);
                                state.queued_sample_rate = Some(spec.sample_rate);
                                state.queued_channels = Some(spec.channels);
                                state.queued_bits_per_sample = spec.bits_per_sample;
                            }
                        }
                        Ok(PreloadOutcome::Skipped { spec, reason }) => {
                            debug_log_event(
                                "audio_thread",
                                &format!(
                                    "{reason}; next specs={} Hz/{} ch/{:?}",
                                    spec.sample_rate, spec.channels, spec.bits_per_sample
                                ),
                            );
                        }
                        Err(err) => eprintln!("{err}"),
                    }
                }

                // Check if the sink has finished playing its current track
                let mut track_ended = sink.empty();

                // Failsafe: if rodio doesn't report empty, but we've exceeded duration by 1s
                if let Ok(state) = inner_clone.lock()
                    && !track_ended
                    && state.is_playing
                    && state.duration_secs > 0.0
                    && state.position_secs >= state.duration_secs + 1.0
                {
                    track_ended = true;
                }

                if track_ended {
                    if let Ok(mut state) = inner_clone.lock()
                        && state.is_playing
                    {
                        state.is_playing = false;
                        state.position_secs = state.duration_secs;
                        should_emit_ended = true;
                    }
                } else if let Ok(mut state) = inner_clone.lock()
                    && state.is_playing
                {
                    update_position_from_sink(
                        &mut state,
                        sink.get_pos().as_secs_f64(),
                        Instant::now(),
                    );
                }

                if should_emit_ended {
                    release_after_track_end = true;
                    if let (Some(player), Some(queue), Some(db)) = (
                        app_handle.try_state::<AudioPlayer>(),
                        app_handle.try_state::<QueueState>(),
                        app_handle.try_state::<Mutex<Database>>(),
                    ) && let Err(err) = crate::commands::playback::advance_to_next(
                        &app_handle,
                        false,
                        &player,
                        &queue,
                        &db,
                    ) {
                        eprintln!("[AudioPlayer] Auto advance failed: {err}");
                    }
                }

                let mut state_to_emit = None;
                let mut progress_to_emit = None;
                if let Ok(mut state) = inner_clone.lock() {
                    let sig = playback_signature(&state);
                    let changed = pending_state_emit || last_emit_sig.as_ref() != Some(&sig);
                    let now = Instant::now();
                    let since_last = now.duration_since(last_progress_emit);
                    let min_elapsed = since_last >= PLAYBACK_STATE_MIN_INTERVAL;
                    let progress_due =
                        playback_progress_due(last_progress_event, now, state.is_playing);
                    if min_elapsed && changed {
                        advance_progress_sequence(&mut state);
                        state_to_emit = Some((
                            playback_state_from_inner(&state, &eq_params_thread),
                            sig,
                            now,
                        ));
                    } else if progress_due {
                        advance_progress_sequence(&mut state);
                        progress_to_emit = Some(PlaybackProgressPayload {
                            position_secs: state.position_secs,
                            duration_secs: state.duration_secs,
                            generation: state.progress_generation,
                            sequence: state.progress_sequence,
                        });
                    }
                }

                if let Some((mut playback_state, sig, now)) = state_to_emit {
                    let state_changed = pending_state_emit || last_emit_sig.as_ref() != Some(&sig);
                    let frontend_visible = app_handle
                        .try_state::<FrontendVisible>()
                        .is_none_or(|state| state.0.load(std::sync::atomic::Ordering::Relaxed));
                    if state_changed || frontend_visible {
                        emit_playback_state(&app_handle, &mut playback_state);
                        let progress = PlaybackProgressPayload {
                            position_secs: playback_state.position_secs,
                            duration_secs: playback_state.duration_secs,
                            generation: playback_state.progress_generation,
                            sequence: playback_state.progress_sequence,
                        };
                        app_handle
                            .emit("playback-progress", &progress)
                            .unwrap_or_else(|error| {
                                eprintln!(
                                    "[AudioPlayer] Failed to emit playback-progress: {error}"
                                );
                            });
                    }

                    // Update System Media Controls (MPRIS / SMTC)
                    if let Some(controls_state) =
                        app_handle.try_state::<Mutex<souvlaki::MediaControls>>()
                        && let Ok(mut controls) = controls_state.lock()
                    {
                        // Update playback position/status
                        if media_progress_due(last_media_progress_update, now, state_changed) {
                            let progress = Some(souvlaki::MediaPosition(Duration::from_secs_f64(
                                playback_state.position_secs.max(0.0),
                            )));
                            let playback = if playback_state.is_playing {
                                souvlaki::MediaPlayback::Playing { progress }
                            } else if playback_state.current_track.is_some() {
                                souvlaki::MediaPlayback::Paused { progress }
                            } else {
                                souvlaki::MediaPlayback::Stopped
                            };
                            if let Err(error) = controls.set_playback(playback) {
                                eprintln!(
                                    "[AudioPlayer] Failed to update media playback state: {error}"
                                );
                            }
                            last_media_progress_update = Some(now);
                        }

                        // Update Metadata if track changed
                        let track_changed = last_emit_sig.as_ref().and_then(|sig| sig.1.as_ref())
                            != playback_state.current_track.as_ref().map(|t| &t.id);
                        if track_changed || last_emit_sig.is_none() {
                            if let Some(ref track) = playback_state.current_track {
                                let cover_url = mpris_cover_url(&app_handle, track);
                                let metadata = souvlaki::MediaMetadata {
                                    title: Some(&track.title),
                                    artist: Some(&track.artist),
                                    album: Some(&track.album),
                                    cover_url: cover_url.as_deref(),
                                    duration: Some(Duration::from_secs_f64(
                                        track.duration_secs.max(0.0),
                                    )),
                                };
                                if let Err(error) = controls.set_metadata(metadata) {
                                    eprintln!(
                                        "[AudioPlayer] Failed to update media metadata: {error}"
                                    );
                                }
                            } else {
                                if let Err(error) =
                                    controls.set_metadata(souvlaki::MediaMetadata::default())
                                {
                                    eprintln!(
                                        "[AudioPlayer] Failed to clear media metadata: {error}"
                                    );
                                }
                            }
                        }
                    }

                    last_emit_sig = Some(sig);
                    last_progress_emit = now;
                    last_progress_event = now;
                    pending_state_emit = false;
                }

                if let Some(progress) = progress_to_emit {
                    let now = Instant::now();
                    publish_progress_update(
                        &app_handle,
                        &progress,
                        &mut last_media_progress_update,
                        now,
                    );
                    last_progress_event = now;
                }
            }

            // Channel disconnected — all senders have been dropped
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break; // Exit the loop
            }
        }
    }

    // Thread is exiting — sink and _stream will be dropped, releasing audio device
}

#[cfg(test)]
mod tests {
    use super::{pending_state_emit_due, progress_publication_due};
    use std::time::{Duration, Instant};

    #[test]
    fn queued_commands_cannot_starve_a_due_state_publication() {
        let last_emit = Instant::now();
        assert!(!pending_state_emit_due(
            true,
            last_emit,
            last_emit + Duration::from_millis(49)
        ));
        assert!(pending_state_emit_due(
            true,
            last_emit,
            last_emit + Duration::from_millis(50)
        ));
        assert!(!pending_state_emit_due(
            false,
            last_emit,
            last_emit + Duration::from_secs(1)
        ));
    }

    #[test]
    fn continuous_command_iterations_publish_due_progress() {
        let start = Instant::now();
        let mut last_progress = start;
        let mut published_at = Vec::new();

        // Model a command being ready on every outer-loop iteration. Progress
        // deadlines are checked before each receive, independent of timeout.
        for elapsed_ms in [25, 50, 75, 100, 125, 150, 175, 200] {
            let now = start + Duration::from_millis(elapsed_ms);
            if progress_publication_due(true, true, last_progress, now) {
                published_at.push(elapsed_ms);
                last_progress = now;
            }
        }

        assert_eq!(published_at, [100, 200]);
        assert!(!progress_publication_due(
            true,
            false,
            last_progress,
            start + Duration::from_millis(300)
        ));
    }
}

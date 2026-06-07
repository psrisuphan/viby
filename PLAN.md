# Viby Audio Quality + Cross-OS Plan

## Context

`handoff.md` lists remaining audio correctness, quality, seek, EQ, and packaging/runtime issues after the playback-quality audit. The next implementation should fix the high-confidence defects without regressing Tauri support on all currently supported desktop targets:

- **macOS**: CoreAudio via `cpal`/`rodio`, Tauri tray, Souvlaki media controls.
- **Windows**: WASAPI via `cpal`/`rodio`, WebView2, SMTC media controls.
- **Linux**: PulseAudio/PipeWire-compatible `cpal` path, AppIndicator/system tray, MPRIS media controls.

The plan below prioritizes small, architecture-preserving fixes first, then the larger native-sample-rate playback work. Shared Rust audio code must remain cross-platform unless a platform-specific API is explicitly required and guarded with `#[cfg(target_os = "...")]`.

## Approach

Implement in ordered phases so each phase can be reviewed and verified independently:

1. **Safe cross-platform correctness fixes**: decoder seek math, EQ channel alignment, TDF2 mode, progress timing, and disabled/dirty-buffer issues. These affect shared Rust code and should behave identically on macOS, Windows, and Linux.
2. **Test coverage for regressions**: add unit tests with fake `Source` implementations where possible, and decoder tests using small fixtures or generated audio only if already supported by the repo test setup.
3. **Cross-OS runtime hardening**: ensure platform integrations are optional/failure-tolerant where they can fail at runtime, especially Souvlaki media controls and tray-related behavior.
4. **Resampling / device-rate architecture**: plan and implement native sample-rate output without making Linux/PipeWire-only assumptions; if opening at the source rate is not supported by rodio 0.20's high-level API, isolate the work behind a small output abstraction and keep a safe fallback.
5. **Packaging/resource checks**: confirm bundled resources and app data paths work on macOS, Windows, and Linux packages, not only Arch/CachyOS dev paths.

## Files to modify

Critical implementation files:

- `src-tauri/src/audio/decoder.rs`
- `src-tauri/src/audio/dsp.rs`
- `src-tauri/src/audio/eq.rs`
- `src-tauri/src/audio/player.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Likely test/documentation files:

- `src-tauri/src/audio/eq.rs` test modules
- `src-tauri/src/audio/queue.rs` or new audio test helpers if needed
- `docs/development.md`
- `README.md`
- `handoff.md` only after implementation, to mark resolved/deferred items

## Reuse

Existing code and patterns to reuse:

- `SymphoniaDecoder::try_seek`, `refine_position`, and `skip_back_a_tiny_bit` in `src-tauri/src/audio/decoder.rs` for all seek fixes.
- `DspEngine::recompute`, `process_sample`, `process_frame`, `flush_buffers`, and resampler buffers in `src-tauri/src/audio/dsp.rs`.
- `EqParams::generation`, `EqParams::snapshot`, `EqSource::recompute`, and `EqSource::try_seek` in `src-tauri/src/audio/eq.rs`.
- `AudioPlayer`'s dedicated audio thread and `AudioCommand` channel in `src-tauri/src/audio/player.rs`; do not move sink operations onto Tauri command threads.
- `app.path().app_data_dir()` usage in `src-tauri/src/lib.rs` and `src-tauri/src/commands/playback.rs` for cross-platform data directories.
- Existing `cargo test -p viby --lib audio`, `cargo check`, and `npm run build` verification commands from `handoff.md`.

## Steps

### Phase 1 — Small shared audio correctness fixes

- [ ] Fix **C1** in `dsp.rs`: when `Topology::Tdf2` is selected, create `Biquad` then set `bq.use_tdf2 = true` before storing it.
- [ ] Fix **C2a** in `dsp.rs`: keep `filter_sample_rate()` at `self.sample_rate` while `EqSource` still uses `process_sample()` instead of oversampled `process_frame()`.
- [ ] Fix **C3** in `decoder.rs`: use `seek_res.required_ts.saturating_sub(seek_res.actual_ts)` in `refine_position()`.
- [ ] Fix **C4** in `eq.rs`: advance `current_channel` for every input sample before returning early for disabled EQ.
- [ ] Fix **C6** in `decoder.rs`: remove `to_skip` and the post-seek `current_frame_offset += to_skip` so accurate seeks remain channel-aligned.
- [ ] Fix **M4** in `player.rs`: reduce seek guard from `500ms` to `50ms`.
- [ ] Fix **M5** in `player.rs`: reduce progress polling from `250ms` to `50ms`, preserving duplicate-event suppression while paused/idle.
- [ ] Fix **M1** in `eq.rs`: read generation before `snapshot()` and assign `last_generation` to that observed generation after applying the snapshot.
- [ ] Fix **C8** in `dsp.rs`: call `reset()` on all rubato upsamplers/downsamplers in `flush_buffers()`.
- [ ] Fix **M2** in `decoder.rs`: make `current_frame_len()` return remaining buffer samples with `saturating_sub(current_frame_offset)`.
- [ ] Fix **C5** in `decoder.rs`: if decode retry advances to a replacement packet after seek, reset the packet-relative skip offset to zero.
- [ ] Fix **M6** in `decoder.rs`: choose the default supported audio track consistently for decoding and duration; fall back to the first supported non-null codec only if no usable default track exists.
- [ ] Fix **M7** in `player.rs`: remove the O(N) sample-consuming seek fallback on the audio thread; on `sink.try_seek()` failure, either keep current playback and report/log the error or reload from start with a clear state update.
- [ ] Fix **I1** in `decoder.rs`: create `MediaSourceStream` with a larger buffer, e.g. `MediaSourceStreamOptions { buffer_len: 512 * 1024 }`.
- [ ] Fix **I5** in `dsp.rs`: upgrade rubato interpolation from `Quadratic` to `Cubic` after confirming the API enum exists in the pinned `rubato = 0.14`.

### Phase 2 — Precision and API cleanup

- [ ] Evaluate **M3**: decide whether `SampleBuffer<f64>` is worth the extra memory/copying while `rodio::Source<Item = f32>` forces f32 output. If implementing, store decoder buffers as `SampleBuffer<f64>` and downcast only in `Iterator::next()`.
- [ ] Fix stale documentation in `eq.rs` source-chain comments so it no longer mentions removed `convert_samples::<f32>()`.
- [ ] Fix **I2**: make `recommended_preamp_gain` accept an actual sample-rate parameter and pass it from `AudioPlayer::recommended_preamp_db()` where available; keep a fallback for no current track/source.

### Phase 3 — Oversampling follow-up, isolated from Phase 1

- [ ] Fix **C7** in `dsp.rs` before wiring oversampling: prevent writes when `block_input_pos >= OVERSAMPLED_BLOCK_SIZE` and define clear drain/accumulate behavior.
- [ ] Implement **C2b** in `eq.rs`: accumulate complete interleaved frames, call `DspEngine::process_frame()`, and drain `frame_out` consistently.
- [ ] After `process_frame()` is truly active for oversampling, restore `filter_sample_rate()` to `sample_rate * oversampling` only for oversampled processing.
- [ ] Add tests that set oversampling to 2x/4x and confirm a 1 kHz PEQ band still peaks near 1 kHz, not 500 Hz or another shifted frequency.

### Phase 4 — Native sample-rate output and OS compatibility

- [ ] Investigate rodio 0.20/cpal capabilities in this codebase for opening output streams at a requested sample rate per track.
- [ ] Add a small output-device abstraction in `player.rs` if needed, keeping current `OutputStream::try_default()` as the fallback.
- [ ] On track load, attempt source-native output rate first; if unavailable, fall back to default device rate and log the fallback once per track.
- [ ] Keep the behavior platform-neutral:
  - [ ] **macOS**: use CoreAudio-supported stream configs; do not assume device clock switching always succeeds.
  - [ ] **Windows**: use WASAPI-supported stream configs; do not require exclusive mode unless explicitly designed and user-configurable.
  - [ ] **Linux**: support PipeWire/PulseAudio default behavior; keep PipeWire `allowed-rates` as optional documentation, not a runtime requirement.
- [ ] If native-rate output requires cpal directly, isolate that work as a separate PR because it may bypass rodio sink behavior and affect seeking, pause/resume, and volume.

### Phase 5 — Cross-OS app integration hardening

- [ ] In `lib.rs`, make Souvlaki media controls initialization non-fatal: log failure and continue without media controls on any OS where setup is unavailable.
- [ ] In `player.rs`, keep media control updates guarded by `try_state`, as currently done, so playback does not depend on MPRIS/SMTC availability.
- [ ] Review tray behavior in `lib.rs` for platform assumptions; keep Linux AppIndicator click behavior documented and ensure Windows/macOS still support show/focus and menu actions.
- [ ] Replace the custom `get_app_data_dir()` pre-builder path logic if possible with a Tauri path API available before setup; if not, document why the env-var fallback is safe on macOS, Windows, and Linux.
- [ ] Audit hardcoded Linux resource candidates (`/usr/share/viby/...`) and keep them as Linux-only fallbacks; bundled resources and app data dir must remain the primary cross-platform paths.
- [ ] Verify `src-tauri/Cargo.toml` target-specific `tauri` dependency sections do not enable `macos-private-api` for non-macOS targets unless required by Tauri; simplify or guard features if needed.

### Phase 6 — Packaging/resource validation

- [ ] Confirm `src-tauri/tauri.conf.json` bundles `target-reference/*` and any headphone measurement resources needed by runtime commands on all package targets.
- [ ] Add/update development docs with platform prerequisites:
  - [ ] macOS: Rust/Tauri requirements and media-control expectations.
  - [ ] Windows: WebView2, MSVC build tools, audio backend expectations.
  - [ ] Linux: WebKitGTK/AppIndicator packages and optional PipeWire rate-switching config.
- [ ] Keep Arch-specific `PKGBUILD` paths documented as Linux packaging extras, not required app behavior.

## OS impact matrix

| Area | macOS | Windows | Linux |
|---|---|---|---|
| Decoder seek/math fixes | Shared Rust; should be identical | Shared Rust; should be identical | Shared Rust; should be identical |
| EQ/DSP fixes | Shared Rust; CoreAudio only sees output samples | Shared Rust; WASAPI only sees output samples | Shared Rust; PipeWire/PulseAudio only sees output samples |
| Progress/seek timing | Shared Tauri event cadence | Shared Tauri event cadence | Shared Tauri event cadence |
| Native sample-rate output | Must query supported CoreAudio configs and fall back | Must query supported WASAPI configs and fall back | Must query PulseAudio/PipeWire configs and fall back |
| Media controls | Souvlaki may fail; app should continue | Souvlaki may fail; app should continue | MPRIS/AppIndicator may fail; app should continue |
| Bundled resources | Prefer Tauri resource/app data paths | Prefer Tauri resource/app data paths | Prefer Tauri resource/app data paths; `/usr/share` as package fallback |

## Verification

Run these on the development machine first:

- [ ] `cd src-tauri && cargo fmt --check`
- [ ] `cd src-tauri && cargo test -p viby --lib audio`
- [ ] `cd src-tauri && cargo test`
- [ ] `cd src-tauri && cargo check`
- [ ] `npm run build`
- [ ] `npm run tauri dev`

Manual playback checks for every supported OS before release:

- [ ] **macOS**: play FLAC/MP3, seek near start/middle/end, toggle EQ on/off mid-stream, test tray show/quit, test media keys/control center if available.
- [ ] **Windows**: same playback/seek/EQ checks, verify no console window in release, test SMTC if available, test paths under `%APPDATA%`.
- [ ] **Linux**: same playback/seek/EQ checks under PipeWire or PulseAudio compatibility, verify MPRIS if available, verify tray/AppIndicator menu, test XDG data path and packaged `/usr/share` fallbacks.

Audio-specific regression checks:

- [ ] Seek never swaps L/R channels after interrupting playback mid-buffer.
- [ ] Toggling EQ disabled/enabled never swaps L/R channels.
- [ ] A 1 kHz PEQ band remains centered around 1 kHz with oversampling disabled and, after Phase 3, with 2x/4x oversampling enabled.
- [ ] Disabled EQ is bit-transparent or within expected float tolerance.
- [ ] Progress bar updates smoothly after seek and does not freeze for 500ms.
- [ ] Failed fast seek does not lock the audio thread for long tracks.

## Deferred / separate PRs

- Full direct-cpal playback engine if rodio 0.20 cannot safely open per-track native sample-rate streams.
- Rodio 0.21 upgrade, because it can change sink/player APIs and should not be mixed with correctness fixes.
- ReplayGain, coefficient smoothing, SVF-as-default policy changes, and volume folded into DSP.
- FLAC MD5 verification (**I4**) if it requires tracking full-file vs partial-seek decode finalization semantics.

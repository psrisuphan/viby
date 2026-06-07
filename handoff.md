# Viby — LLM Handoff Document

**Branch:** `review/playback-quality`
**Last commit:** `a580976` — fix: preserve 24-bit FLAC precision and correct several audio quality bugs
**Date written:** 2026-06-07

---

## What This Project Is

Viby is a local music player built with **Tauri 2** (Rust backend) + **React** (TypeScript frontend). It indexes a local music library into SQLite, plays FLAC/MP3/AAC/OGG files with a full DSP pipeline, and has a system tray, MPRIS integration, and a parametric/graphic equalizer.

**Stack:**
- `rodio 0.20.1` — audio sink and output stream
- `cpal 0.15.3` — cross-platform audio I/O (PipeWire via PulseAudio compat on Linux)
- `symphonia 0.5.4` — FLAC/MP3 demuxing and decoding
- `rubato 0.14.1` — sinc resampler for EQ oversampling
- `math-iir-fir 0.5.14` — biquad (TDF2/DF1) and SVF filter implementations
- `souvlaki` — MPRIS / SMTC media controls

**Key source files:**
```
src-tauri/src/audio/
  decoder.rs   — SymphoniaDecoder (Source<Item=f32>), seekable FLAC/MP3 decoding
  player.rs    — AudioPlayer, dedicated audio thread, all playback commands
  eq.rs        — EqSource (rodio Source adapter), EqParams (lock-free atomics), GEQ/PEQ
  dsp.rs       — DspEngine: TDF2/SVF filter banks, rubato oversampling pipeline
  queue.rs     — PlaybackQueue (shuffle, repeat, navigation)
src-tauri/src/
  lib.rs       — Tauri app setup, tray, MPRIS init
  commands/playback.rs — Tauri command handlers for frontend ↔ backend
  library/     — SQLite DB, file scanner, metadata extraction (lofty)
  models.rs    — shared structs (Track, PlaybackState, RepeatMode, ...)
```

---

## What Was Done In This Session

### Session Work (branch: `review/playback-quality`)

A deep audit + internet research workflow was run on the entire audio backend. Seven bugs were fixed in commit `a580976`:

| Fixed | File | Change |
|---|---|---|
| `SampleBuffer<i16>` → `f32` | `decoder.rs` | 24-bit FLAC was truncated to 16-bit (48 dB dynamic range lost) |
| `total_duration` nanoseconds formula | `decoder.rs:209` | `1/frac` → `frac * 1e9` (was giving 2 ns instead of 500 ms) |
| Decode retry loops | `decoder.rs:148,171` | Loops didn't `break` on success, consumed extra packets every call |
| `skip_back_a_tiny_bit` wraparound | `decoder.rs:255` | `1.0 - frac` → `1.0 + frac` when frac < 0 (was producing frac > 1.0) |
| Remove `convert_samples::<f32>()` | `player.rs` | Redundant since decoder now emits f32 |
| Skip disabled EQ bands | `dsp.rs` | Was creating and running identity peak filters for disabled bands |
| Pre-allocate block buffers | `dsp.rs` | `process_block()` was heap-allocating every call |
| Sinc interpolation upgrade | `dsp.rs:449` | `Linear` → `Quadratic` |

---

## Remaining Known Issues — Prioritized

These were found by the audit but **not yet fixed**. They are ordered by impact.

### Do Immediately (trivial fixes, high impact)

**C1 — `Topology::Tdf2` silently runs Direct Form I**
- `dsp.rs:91–96`
- `math-iir-fir`'s `Biquad::new()` defaults `use_tdf2 = false`. Every "TDF2" filter runs DF1.
- DF1 is less numerically stable for high-Q, low-frequency filters. Also blocks use of `BiquadCoefficients::lerp()` for smooth parameter transitions.
- Fix:
```rust
Topology::Tdf2 => {
    let mut bq = Biquad::new(to_biquad_type(kind), freq, sample_rate, q, gain_db);
    bq.use_tdf2 = true;
    FilterState::Biquad(bq)
}
```

**C2a — `filter_sample_rate()` returns wrong rate when oversampling > 1**
- `dsp.rs:392–394`
- Returns `sample_rate * oversampling`. But `EqSource` calls `process_sample()` which runs at `sample_rate`. Result: biquad coefficients computed at 88.2 kHz, applied at 44.1 kHz. A 1 kHz PEQ band at 2x oversampling actually filters at ~500 Hz.
- Fix: always return `self.sample_rate` until `process_frame()` is properly wired.

**C3 — `refine_position` unsigned subtraction wraps on u64 underflow**
- `decoder.rs:137`
- `seek_res.required_ts - seek_res.actual_ts` — Symphonia doesn't guarantee actual ≤ required. If actual > required, this wraps to near `u64::MAX`. The packet-scan loop then reads the entire file, exhausting the decoder. All subsequent seeks produce silence.
- Fix: `seek_res.required_ts.saturating_sub(seek_res.actual_ts)`

**C4 — `EqSource` swaps L/R channels when EQ is re-enabled mid-stream**
- `eq.rs:367–376`
- When `!self.enabled`, `next()` returns early without advancing `current_channel`. Counter drifts. On re-enable, wrong channel filter is applied. For stereo: permanent L/R swap until track reload.
- Fix: advance `current_channel` before checking `enabled`:
```rust
let ch = self.current_channel;
self.current_channel = (self.current_channel + 1) % self.channels;
if !self.enabled { return Some(sample); }
let processed = self.dsp.process_sample(ch, sample as f64);
Some(processed as f32)
```

**C6 — `to_skip` in `try_seek` corrupts channel alignment post-seek**
- `decoder.rs:226–240`
- `to_skip = current_frame_offset % channels` is captured from the pre-seek buffer, then added to the post-seek channel-aligned offset. `refine_position()` always produces a channel-aligned offset (`samples_to_pass * channels`). Adding `to_skip` then misaligns it, swapping L/R after any seek that interrupts mid-buffer.
- Fix: delete the `to_skip` computation and the `+= to_skip` line entirely.

**M4 — `seek_guard_until` is 500 ms (should be 50 ms)**
- `player.rs:315`
- With native `SymphoniaDecoder::try_seek`, rodio's position counter converges within one cpal callback (< 22 ms on PipeWire). The 500 ms guard freezes the progress bar for half a second after every seek.
- Fix: `Duration::from_millis(50)`

**M5 — Progress poll is 250 ms (4 Hz updates, visibly jerky)**
- `player.rs:181`
- Change `recv_timeout(Duration::from_millis(250))` to `from_millis(50)`. The tick body is O(1).

### High Priority

**M1 — TOCTOU in EQ generation check**
- `eq.rs:293–337`
- `recompute()` reads `params.snapshot()` first, then `params.generation()`. A UI write between those two lines bumps generation, but `last_generation` stores the new (unseen) value. The next 256-sample check sees gen == last_generation and skips recompute. Parameter writes under rapid UI changes are silently dropped.
- Fix: read `gen = self.params.generation()` first, then `snap = self.params.snapshot()`, then `self.last_generation = gen` at the end.

**C8 — `flush_buffers()` leaves rubato sinc delay lines dirty after seek**
- `dsp.rs:381–388`
- Does not call `r.reset()` on upsamplers/downsamplers. After a seek, the sinc delay line (64 samples deep) retains pre-seek audio. Post-seek output is contaminated by those 64 samples. (Currently inert because oversampling is not wired, but must be fixed before C2b.)
- Fix: add `for r in self.upsamplers.iter_mut() { r.reset(); }` and same for downsamplers.

**M2 — `current_frame_len()` returns total buffer length, not remaining**
- `decoder.rs:192`
- Breaks rodio's rate-change detection for gapless playback between tracks at different sample rates.
- Fix: `Some(self.buffer.len().saturating_sub(self.current_frame_offset))`

**C5 — Seek retry uses stale `samples_to_pass` after fetching a replacement packet**
- `decoder.rs:147–158`
- If the initial packet decode fails and a replacement packet is fetched, `samples_to_pass` still reflects the offset into the original (now discarded) packet. `current_frame_offset` is set to this stale offset in the new packet → wrong content after any seek on a file with a corrupted frame.
- Fix: if retrying with a new packet, reset `samples_to_pass = 0` and `current_frame_offset = 0` for the replacement.

### Medium Priority

**M3 — `SampleBuffer<f32>` loses 1 bit for 24-bit FLAC**
- `decoder.rs:129`
- Symphonia left-shifts 24-bit samples to i32, then converts i32→f32 via `(s as f64 / 2_147_483_648.0) as f32`. f32 has 23 mantissa bits, so 1 bit of the 24-bit source is lost per sample.
- Fix: use `SampleBuffer<f64>` internally; downcast to f32 only in `Iterator::next()` (rodio's `Source` trait forces `Item = f32`). This also eliminates the redundant f32→f64 cast in `EqSource::next()`.

**C9 — Mandatory linear-interpolation resampling for 44.1 kHz FLACs (dominant quality loss)**
- `player.rs:150`
- `OutputStream::try_default()` opens at the device default rate (48 kHz on PipeWire/CachyOS). Any 44.1 kHz FLAC passes through rodio's `SampleRateConverter` — a lerp resampler with no anti-aliasing filter (rodio issue #584). This is the single largest quality loss for typical CD-quality libraries.
- Proper fix: open `OutputStream` at the source file's native sample rate. PipeWire 0.3.61+ supports hardware clock switching via `allowed-rates` config. The per-track stream open/close cost is one PipeWire negotiation.
- Short-term mitigation: apply a low-pass pre-filter before the sink when downsampling is detected.
- This is a medium-large architectural change.

**M6 — Track selection mismatched with `default_track()` for duration**
- `decoder.rs:78–91`
- Track is found by `find(codec != CODEC_TYPE_NULL)` but total_duration is read from `format.default_track()`. These differ in some multi-stream containers, causing wrong seek math.
- Fix: use `default_track()` for both (with manual scan fallback).

**M7 — O(N) fallback seek is catastrophic for long files**
- `player.rs:286–291`
- If `sink.try_seek()` fails, iterates `position × sample_rate × channels` samples one-by-one on the audio message thread. For a 60-min 96 kHz stereo file: ~691 million `next()` calls. The audio thread is unresponsive for minutes.
- Fix: remove the loop. Log the error, reload the track from position 0, or propagate the seek failure. The fallback should never consume samples on this thread.

### Low Priority / Future Work

**C7 — OOB write in `process_frame` oversampling path (UB in release)**
- `dsp.rs:278`
- On the 257th input frame while draining output, `block_input_pos` is still 256 and writes past the end of a 256-element buffer. Debug: panic. Release: UB. Currently inert because `process_frame()` is never called. Must fix before C2b.

**C2b — Wire `process_frame()` in `EqSource` to make oversampling actually work**
- Large change. All of C8, C7, and C2a must be done first.
- `EqSource::next()` needs to accumulate complete interleaved frames, call `dsp.process_frame()`, store results in `frame_out`, and drain. The drain logic already exists (eq.rs:350–355); only the accumulation and call are missing.
- Restore `filter_sample_rate()` to `sample_rate * oversampling` only after this is done.

**I1 — MediaSourceStream buffer 64 KB (too small for large FLAC frames at 96 kHz)**
- `decoder.rs:61`
- Fix: `MediaSourceStreamOptions { buffer_len: 512 * 1024 }`

**I2 — `recommended_preamp_gain` hardcodes 48000 Hz sample rate**
- `eq.rs:449`
- Fix: pass actual `sample_rate: f64` parameter through from the caller.

**I4 — FLAC MD5 never verified**
- `decoder.rs:86`
- Fix: `DecoderOptions { verify: true }`, check `decoder.finalize().verify_ok` at end of stream. Note: ignore when seek was used (partial MD5 is meaningless).

**I5 — `SincInterpolationType::Quadratic` → `Cubic` (free quality for stereo)**
- `dsp.rs:449` — one-line change, no downsides.

**I6 — cpal `BufferSize::Default` can be huge**
- Some hardware reports 4096 frames (85 ms latency). Use `BufferSize::Fixed(512)` (~11 ms at 48 kHz).

**Longer term:**
- rodio 0.21 upgrade: native PipeWire backend via cpal, better API (Sink→Player rename, etc.)
- ReplayGain: Symphonia reads the Vorbis comment tags; apply via a `replaygain_linear` field in `DspEngine`
- Coefficient smoothing to eliminate zipper noise on live EQ changes (requires C1/TDF2 first, then `BiquadCoefficients::lerp()`)
- SVF topology as default for bands above 8 kHz (better HF accuracy vs TDF2 bilinear warping)
- Volume folded into DSP chain at f64 precision instead of rodio's f32 `Amplify`

---

## Not Worth Doing

Confirmed by research to be wasted effort on this stack:
- **Dithering on f32 output** — f32 noise floor is −144 dBFS, inaudible on any DAC
- **Software noise shaping** — hardware DAC delta-sigma shaping supersedes it
- **DC offset removal as default** — commercial FLAC never has DC offset
- **Linear-phase FIR EQ** — IIR pre-ringing is more audible than IIR post-ringing; SVF is correct
- **sinc_len > 128** — BlackmanHarris2 at 128 gives −140 dB stopband, no audible gain from doubling
- **f64 SampleRateConverter** — rodio's lerp is broken algorithmically, not by float width
- **JACK backend** — PipeWire at 512 frames is < 11 ms, sufficient for a music player

---

## Architecture Notes

### Audio thread architecture
All audio operations run on a single dedicated thread (`player.rs`). Tauri commands send `AudioCommand` messages via `mpsc::channel`. Shared state (`AudioPlayerInner`) is behind `Arc<Mutex<>>`. EQ parameters (`EqParams`) are lock-free atomics — the audio thread reads without locking. This is correct and should not be changed.

### EQ parameter flow
1. Frontend → Tauri command → `AudioPlayer::set_eq()` or `set_peq()`
2. Writes to `EqParams` atomics, bumps `generation` counter
3. `EqSource::next()` checks generation every 256 samples (`RECHECK_INTERVAL`)
4. On change: `recompute()` reads a snapshot and rebuilds filter coefficients

### Source chain
```
SymphoniaDecoder (f32) → EqSource (f32 in/out, f64 internal) → rodio Sink → cpal → OS
```
rodio's `Sink::append()` wraps the source in `UniformSourceIterator` which applies `SampleRateConverter` if source rate ≠ device rate. This is where quality is silently lost for 44.1 kHz FLACs on 48 kHz devices.

### Seeking
`SymphoniaDecoder::try_seek()` → `FormatReader::seek(SeekMode::Accurate)` → `refine_position()`. This is Symphonia's native seek, which binary-searches the FLAC frame index. The `EqSource::try_seek()` delegates to the inner source and calls `dsp.flush_buffers()` to reset filter state. After any seek, a 500 ms guard (M4: should be 50 ms) prevents `sink.get_pos()` instability from corrupting the displayed position.

### Oversampling (currently broken)
The full oversampling pipeline (rubato upsample → filter at 2x rate → rubato downsample) is built in `DspEngine` but **never connected** to `EqSource`. Setting oversampling > 1 currently:
1. Makes `filter_sample_rate()` return wrong rate → wrong EQ frequencies (C2a)
2. Rebuilds rubato resamplers that are never fed data

Do C2a first (fix `filter_sample_rate`), then tackle C2b (wire `process_frame`) as a separate large PR.

---

## Testing

```bash
# All audio unit tests (EQ, queue, decoder correctness)
cargo test -p viby --lib audio

# Full build check
cargo check

# Run the app (dev mode)
npm run tauri dev
```

18 tests exist covering: EQ gain response, transparent bypass, PEQ peaking, live parameter pickup, queue navigation/shuffle/repeat.

---

## PipeWire / OS Notes (CachyOS)

The `libayatana-appindicator` deprecation warning at startup is expected and cannot be fixed at the Viby level — it originates inside rodio/cpal's `libappindicator-sys` which hard-codes dlopen of `libayatana-appindicator3.so.1`. The migration to `libayatana-appindicator-glib` must happen upstream.

For audiophile PipeWire configuration (bit-perfect rate switching), users should add:
```
# ~/.config/pipewire/pipewire.conf.d/99-rates.conf
context.properties = {
    default.clock.rate = 48000
    default.clock.allowed-rates = [ 44100 48000 88200 96000 ]
}
```
This enables hardware clock switching so PipeWire matches the source sample rate when only Viby is playing, making rodio's `SampleRateConverter` a no-op.

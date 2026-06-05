# Viby Architecture

## Overview

Viby uses a **two-process architecture** powered by [Tauri 2](https://v2.tauri.app/):

```
┌──────────────────────────────────────────────────┐
│                   Tauri Shell                      │
│  ┌───────────────────┐  ┌───────────────────────┐ │
│  │  Frontend          │  │  Backend (Rust)        │ │
│  │  (WebView)         │  │                        │ │
│  │  React + TS        │  │  ┌──────────────────┐  │ │
│  │  Zustand stores    │  │  │  Audio Engine     │  │ │
│  │  Vanilla CSS       │  │  │  (dedicated thread│  │ │
│  │                    │  │  │  owns rodio Sink) │  │ │
│  │  invoke() ─────────┼──┼─►  Tauri Commands   │  │ │
│  │  listen() ◄────────┼──┼──  Tauri Events     │  │ │
│  │                    │  │  │                   │  │ │
│  │                    │  │  ├──────────────────┤  │ │
│  │                    │  │  │  SQLite DB        │  │ │
│  │                    │  │  │  (FTS5 + WAL)     │  │ │
│  └───────────────────┘  └───────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## Frontend → Backend Communication

### Commands (Frontend → Rust)
All IPC calls go through wrapper functions in `src/utils/tauri.ts`:

```typescript
// Play a track by its library ID (not file path)
await invoke('play_track', { trackId: 'uuid-here' });

// Get all tracks from library
const tracks = await invoke<Track[]>('get_all_tracks');
```

### Events (Rust → Frontend)
The backend pushes real-time updates via named events:

```typescript
import { listen } from '@tauri-apps/api/event';

// Playback state (position, volume, is_playing) — every 250ms
await listen<PlaybackState>('playback-state', (e) => { ... });

// Queue changed (add/remove/reorder)
await listen<QueuePayload>('queue-changed', (e) => { ... });

// Scan progress (batched — every 50 files)
await listen<ScanProgress>('scan-progress', (e) => { ... });
```

## Audio Engine (`src-tauri/src/audio/`)

The audio engine runs in a **dedicated OS thread** because `rodio::Sink` is not `Send`/`Sync`:

```
Tauri command  ──mpsc::send()──►  Audio Thread (owns Sink)
                                        │
Frontend  ◄──app.emit()──  250ms tick ──┘
```

**Key behaviours:**
- Position is read from `Sink::get_pos()` — no drift.
- On `Drop`, `AudioPlayer` sends `AudioCommand::Shutdown` so the thread exits cleanly and the OS audio device is released without a pop.
- `SendError` from a dead thread is logged via `eprintln!` and surfaced as `AppError::Audio`.

**`QueueState`** (`src-tauri/src/audio/queue.rs`) wraps `PlaybackQueue` in a `Mutex` and is registered as Tauri managed state. It lives in the audio module (not the commands module) because it is an audio-domain concept.

## Database (`src-tauri/src/library/database.rs`)

SQLite with WAL mode and foreign key enforcement.

### Schema

| Table | Purpose |
|---|---|
| `tracks` | Every audio file with full metadata |
| `tracks_fts` | FTS5 virtual table mirroring `tracks` for full-text search |
| `playlists` | User-created playlists |
| `playlist_tracks` | Junction table (playlist ↔ track, ordered by `position`) |
| `library_folders` | Registered music directory paths |

### Migration system

`Database::open()` calls `run_migrations()` which uses `PRAGMA user_version` to track the schema version and runs each migration block exactly once:

- **v0 → v1**: Initial schema (all four base tables + indexes)
- **v1 → v2**: FTS5 virtual table + `AFTER INSERT/UPDATE/DELETE` triggers to keep it in sync

New migrations are added as `if version < N { ... }` blocks. Existing installs upgrade automatically on next launch.

### Full-text search

`search_tracks()` uses `tracks_fts MATCH ?` with prefix tokens (`"word"*`) instead of `LIKE '%query%'`, which can use indexes. Results are ranked by FTS5 relevance.

### Scan performance

`scan_library` in `src-tauri/src/commands/library.rs`:
1. Pre-loads all existing file paths into a `HashSet` (one DB read).
2. Extracts metadata for new files outside any lock.
3. Wraps all inserts in a single `BEGIN IMMEDIATE … COMMIT` transaction via `upsert_tracks_batch()`.
4. Emits `scan-progress` every 50 files (not every file) to avoid IPC thundering-herd.
5. A `ScanLock(AtomicBool)` managed state prevents concurrent scan invocations.

## Error Handling (`src-tauri/src/error.rs`)

All Tauri commands return `Result<T, AppError>`. `AppError` is serialised as `{ kind, message }` so the frontend can distinguish categories:

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    Database(String),
    Audio(String),
    NotFound(String),
    Io(String),
    ScanBusy,
    Other(String),
}
```

`From<rusqlite::Error>` and `From<std::io::Error>` are implemented so callers can use `.map_err(AppError::from)?`.

## State Management (Frontend)

Zustand stores in `src/stores/`:

| Store | Purpose |
|---|---|
| `playerStore` | Playback state — is_playing, position, volume, shuffle, repeat. Volume/shuffle/repeat persist to localStorage. |
| `libraryStore` | Tracks, albums, artists, genres, scan progress |
| `queueStore` | Current queue tracks + current index, synced from `queue-changed` events |
| `uiStore` | Active section/view, selected album/artist/playlist, modal open states |
| `toastStore` | Short-lived notification toasts (auto-dismiss) |

## Platform Detection (`src/utils/platform.ts`)

`getPlatform()` reads `navigator.userAgent` to return `'macos' | 'windows' | 'linux'`. Used by `Titlebar.tsx` to render macOS traffic lights (left) or Windows/Linux controls (right) — no `@tauri-apps/plugin-os` dependency needed.

## Artwork (`src/utils/useArtwork.ts`)

- Backend detects MIME type from magic bytes and returns `{ data: string, mime_type: string }`.
- Frontend builds `data:${mime_type};base64,${data}` URLs.
- Global LRU cache (max 200 entries, insertion-order eviction) prevents unbounded memory growth.
- Request deduplication: concurrent calls for the same track ID share one in-flight promise.

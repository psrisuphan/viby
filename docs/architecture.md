# Viby Architecture

## Overview

Viby uses a **two-process architecture** powered by [Tauri 2](https://v2.tauri.app/):

```
┌─────────────────────────────────────────────────┐
│                  Tauri Shell                      │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   Frontend        │  │   Backend (Rust)      │  │
│  │   (WebView)       │◄─┤                       │  │
│  │                   │  │  ┌─────────────────┐  │  │
│  │  React + TS       │  │  │  Audio Engine    │  │  │
│  │  Zustand State    │  │  │  (rodio thread)  │  │  │
│  │  Vanilla CSS      │  │  └─────────────────┘  │  │
│  │                   ├──►                       │  │
│  │  invoke() ──────────► Tauri Commands        │  │
│  │  listen() ◄────────── Tauri Events          │  │
│  │                   │  │                       │  │
│  │                   │  │  ┌─────────────────┐  │  │
│  │                   │  │  │  SQLite DB       │  │  │
│  │                   │  │  │  (library index) │  │  │
│  │                   │  │  └─────────────────┘  │  │
│  └──────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Frontend → Backend Communication

### Commands (Frontend → Rust)
The frontend calls Rust functions via `invoke()`:
```typescript
import { invoke } from '@tauri-apps/api/core';

// Play a track
await invoke('play_track', { path: '/path/to/song.mp3' });

// Get all tracks from library
const tracks = await invoke<Track[]>('get_all_tracks');
```

### Events (Rust → Frontend)
The backend pushes real-time updates via events:
```typescript
import { listen } from '@tauri-apps/api/event';

// Listen for track progress updates (~10 times/sec)
await listen<TrackProgress>('track-progress', (event) => {
  updateProgressBar(event.payload.position_secs);
});
```

## Audio Engine

The audio engine runs in a **dedicated OS thread** (not async) because:
1. `rodio::Sink` is not `Send`/`Sync` safe
2. Audio processing must never be blocked by UI operations
3. A separate thread ensures gapless, glitch-free playback

Communication uses `mpsc` channels:
```
Frontend  ──invoke()──►  Tauri Command  ──channel.send()──►  Audio Thread
                                                                │
Frontend  ◄──event──────  Event Emitter  ◄───progress tick──────┘
```

## Database Schema

SQLite stores the indexed library for instant queries:

- **tracks** — Every song with full metadata
- **playlists** — User-created playlists
- **playlist_tracks** — Junction table (playlist ↔ track, with ordering)
- **library_folders** — Registered music directory paths

## State Management

Zustand stores on the frontend:

| Store | Purpose |
|---|---|
| `playerStore` | Playback state, volume, progress, shuffle/repeat |
| `libraryStore` | Tracks, albums, artists, genres, scan state |
| `queueStore` | Current playback queue |
| `uiStore` | Sidebar state, modals, active view |

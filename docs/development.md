# Development Guide

## Prerequisites

### All Platforms
- [Node.js](https://nodejs.org/) v18 or later
- [Rust](https://www.rust-lang.org/tools/install) (latest stable via `rustup`)
- npm (comes with Node.js)

### macOS
```bash
xcode-select --install
```

### Windows
- Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  - Select "Desktop development with C++"
- WebView2 is pre-installed on Windows 10 (1803+) and Windows 11

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev
```

## Setup

```bash
git clone https://github.com/psrisuphan/viby.git
cd viby
npm install
npm run tauri dev
```

This starts the Vite dev server at `localhost:1420`, compiles the Rust backend, and launches the Tauri window with hot-reload.

## Project Structure

```
viby/
├── src/                            # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── layout/                 # Titlebar, Sidebar, PlayerBar
│   │   ├── library/                # SongTable, AlbumGrid, ArtistList, LibraryView
│   │   ├── player/                 # QueuePanel
│   │   ├── playlist/               # PlaylistView, AddToPlaylistModal
│   │   ├── search/                 # SearchModal
│   │   ├── home/                   # HomeView
│   │   └── ui/                     # ContextMenu, TrackMetadataModal, FolderManagementModal, ToastContainer
│   ├── stores/                     # Zustand stores (player, library, queue, ui, toast)
│   ├── styles/                     # design-tokens.css, reset.css, globals.css
│   ├── utils/
│   │   ├── tauri.ts                # All invoke() / listen() wrappers
│   │   ├── useArtwork.ts           # Artwork fetch hook with LRU cache
│   │   ├── filterTracks.ts         # Client-side search filter (also tested)
│   │   ├── formatTime.ts           # Time / file-size formatting
│   │   └── platform.ts             # OS detection (macOS / Windows / Linux)
│   └── types.ts                    # Shared TypeScript types
│
├── src-tauri/                      # Backend (Rust)
│   ├── src/
│   │   ├── audio/
│   │   │   ├── player.rs           # Audio engine (rodio, dedicated thread)
│   │   │   └── queue.rs            # PlaybackQueue + QueueState managed state
│   │   ├── library/
│   │   │   ├── database.rs         # SQLite + FTS5 + migration framework
│   │   │   ├── scanner.rs          # Recursive audio file discovery
│   │   │   └── metadata.rs         # Tag extraction (lofty)
│   │   ├── commands/
│   │   │   ├── playback.rs         # play_track, pause, seek, queue commands
│   │   │   ├── library.rs          # scan_library, search, artwork, browse
│   │   │   └── playlist.rs         # Playlist CRUD
│   │   ├── error.rs                # AppError — unified error type for all commands
│   │   ├── models.rs               # Shared Rust structs (Track, Album, etc.)
│   │   ├── utils.rs                # current_timestamp()
│   │   └── lib.rs                  # App setup, managed state, command registration
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── docs/                           # Architecture and development docs
├── package.json
├── vite.config.ts                  # Vite + Vitest config
└── tsconfig.json
```

## Useful Commands

| Command | Description |
|---|---|
| `npm run tauri dev` | Start dev mode (frontend + backend) |
| `npm run tauri build` | Build production bundle |
| `npm run dev` | Vite dev server only (no Tauri shell) |
| `npm test` | Frontend unit tests (Vitest) |
| `cd src-tauri && cargo test` | Rust unit + integration tests |
| `cd src-tauri && cargo clippy` | Rust linter |
| `cd src-tauri && cargo build` | Compile Rust backend only |

## Adding a New Tauri Command

1. Define the function in `src-tauri/src/commands/`:

   ```rust
   use crate::error::AppError;

   #[tauri::command]
   pub fn my_command(param: String) -> Result<String, AppError> {
       Ok(format!("Hello {}", param))
   }
   ```

   Use `AppError` (not `String`) so the frontend receives a structured `{ kind, message }` object.

2. Register it in `src-tauri/src/lib.rs`:

   ```rust
   .invoke_handler(tauri::generate_handler![
       // ... existing commands
       commands::my_module::my_command,
   ])
   ```

3. Add a typed wrapper in `src/utils/tauri.ts`:

   ```typescript
   export async function myCommand(param: string): Promise<string> {
     return invoke('my_command', { param });
   }
   ```

## Adding a Database Migration

Open `src-tauri/src/library/database.rs` and add a new block at the end of `run_migrations()`:

```rust
if version < 3 {          // increment this
    conn.execute_batch("
        ALTER TABLE tracks ADD COLUMN new_field TEXT;
    ")?;
    set_schema_version(conn, 3);  // and this
}
```

The migration runs exactly once on next launch for any existing database. Fresh installs run all blocks in order.

## CSS Design System

All design tokens are in `src/styles/design-tokens.css`. Use CSS custom properties:

```css
.my-component {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  transition: all var(--transition-base);
}

.my-component:hover {
  background: var(--bg-elevated);
  box-shadow: var(--shadow-glow);
}
```

Key token groups: `--bg-*`, `--text-*`, `--accent-*`, `--border-*`, `--shadow-*`, `--space-*`, `--radius-*`, `--transition-*`, `--font-size-*`.

## Testing

### Frontend (Vitest)
Tests live next to the code they test:
```
src/utils/filterTracks.ts
src/utils/filterTracks.test.ts   ← test file
```

Run with `npm test`. Add new test files as `*.test.ts` anywhere under `src/`.

### Rust
Tests live inside the module they test, gated with `#[cfg(test)]`:

```rust
// src-tauri/src/audio/queue.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn my_test() { ... }
}
```

Database tests use `Connection::open_in_memory()` so no file is created.

Run with `cd src-tauri && cargo test`.

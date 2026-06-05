# Viby

<p align="center">
  <strong>A modern, minimal, and aesthetic local music player</strong>
</p>

<p align="center">
  Built with Tauri 2 · React · TypeScript · Rust
</p>

---

## Features

- **Offline-first** — zero cloud dependencies, everything runs locally
- **Cross-platform** — Windows, Linux, and macOS (OS-aware window controls)
- **Blazing fast** — Rust-powered audio engine with gapless playback
- **Beautiful UI** — dark theme with pastel mint green accents, glassmorphism, micro-animations
- **Large library support** — virtualized lists handle 20,000+ songs smoothly
- **Full format support** — MP3, FLAC, WAV, OGG, AAC, M4A, AIFF, ALAC
- **Noto Sans typography** — Latin and Thai script support out of the box

### Core
- Library management with folder scanning and metadata indexing
- Shuffle, repeat (off / one / all), and drag-to-reorder queue
- Playlist creation and management
- Instant full-text search on the Songs page (title, artist, album, genre, year, filename)
- Global search modal (`Ctrl+K`)
- Song Info metadata modal (right-click any track)
- Theater / full-screen artwork mode

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | [Tauri 2](https://v2.tauri.app/) | Cross-platform desktop shell |
| Frontend | React 19 + TypeScript | UI components & state |
| Styling | Vanilla CSS | Custom design system |
| State | Zustand | Lightweight state management |
| Testing | Vitest | Frontend unit tests |
| Audio | Rust: rodio + symphonia | Audio decoding & playback |
| Metadata | Rust: lofty | Read audio tags |
| Database | Rust: rusqlite (SQLite + FTS5) | Local library index with full-text search |
| Errors | Rust: thiserror | Structured error types |
| Icons | Lucide React | Icon set |
| Font | Noto Sans / Noto Sans Thai | Latin + Thai typography |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- Platform-specific Tauri dependencies — see [Tauri Prerequisites](https://tauri.app/start/prerequisites/)

### Development

```bash
# Clone the repo
git clone https://github.com/psrisuphan/viby.git
cd viby

# Install frontend dependencies
npm install

# Run in development mode (starts Vite dev server + Tauri)
npm run tauri dev
```

### Building

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

### Testing

```bash
# Frontend unit tests (Vitest)
npm test

# Rust unit + integration tests
cd src-tauri && cargo test
```

## Project Structure

```
viby/
├── src/                     # React frontend
│   ├── components/          # UI components (layout, library, player, ui, etc.)
│   ├── stores/              # Zustand state stores
│   ├── styles/              # CSS design tokens and globals
│   ├── utils/               # Helpers, Tauri IPC wrappers, hooks
│   └── types.ts             # Shared TypeScript types
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── audio/           # Audio engine + playback queue
│   │   ├── library/         # Scanner, metadata parser, SQLite DB + migrations
│   │   ├── commands/        # Tauri command handlers
│   │   ├── error.rs         # Unified AppError type
│   │   └── lib.rs           # App entry point + command registration
│   └── Cargo.toml           # Rust dependencies
├── docs/                    # Architecture and development docs
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## License

MIT License — see [LICENSE](LICENSE) for details.

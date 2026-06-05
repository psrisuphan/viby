# Viby

<p align="center">
  <strong>🎵 A modern, minimal, and aesthetic local music player</strong>
</p>

<p align="center">
  Built with Tauri 2 · React · TypeScript · Rust
</p>

---

## ✨ Features

- **Offline-first** — zero cloud dependencies, everything runs locally
- **Cross-platform** — Windows, Linux, and macOS
- **Blazing fast** — Rust-powered audio engine with gapless playback
- **Beautiful UI** — dark theme with pastel mint green accents, glassmorphism, micro-animations
- **Large library support** — virtualized lists handle 20,000+ songs smoothly
- **Full format support** — MP3, FLAC, WAV, OGG, AAC, M4A, AIFF, ALAC

### Core
- 🎶 Library management with folder scanning and metadata indexing
- 🔀 Shuffle, repeat (off/one/all), and queue management
- 📋 Playlist creation and management
- 🔍 Instant global search (`Ctrl+K`)
- ⌨️ Full keyboard shortcut support

### Premium
- 🎛️ 10-band equalizer with presets
- 🎨 Adaptive UI theming from album artwork
- 🖼️ Theater / full-screen mode
- 📌 Mini player (compact floating window)
- 🔔 System tray integration with media key support

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | [Tauri 2](https://v2.tauri.app/) | Cross-platform desktop shell |
| Frontend | React 19 + TypeScript | UI components & state |
| Styling | Vanilla CSS | Custom design system |
| State | Zustand | Lightweight state management |
| Audio | Rust: rodio + symphonia | Audio decoding & playback |
| Metadata | Rust: lofty | Read audio tags |
| Database | Rust: rusqlite (SQLite) | Local library index |
| Icons | Lucide React | Clean icon set |
| Font | Inter | Modern typography |

## 🚀 Getting Started

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

# Run in development mode (starts both Vite dev server and Tauri)
npm run tauri dev
```

### Building

```bash
# Build production bundle
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## 📁 Project Structure

```
viby/
├── src/                     # React frontend
│   ├── components/          # UI components (layout, library, player, etc.)
│   ├── stores/              # Zustand state stores
│   ├── styles/              # CSS design system
│   ├── utils/               # Helpers and Tauri IPC wrappers
│   └── types.ts             # Shared TypeScript types
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── audio/           # Audio engine (rodio + symphonia)
│   │   ├── library/         # Scanner, metadata parser, SQLite DB
│   │   └── commands/        # Tauri command handlers
│   ├── capabilities/        # Tauri security permissions
│   └── Cargo.toml           # Rust dependencies
├── docs/                    # Documentation
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with 💚 and a lot of music
</p>

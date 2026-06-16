# Viby

A modern, high-performance, local-first music player built with Tauri 2, React, and Rust. Designed with a focus on speed, elegant design, and complete offline privacy.

## Overview

Viby is a lightweight local audio player that combines a responsive React frontend with a robust, multi-threaded Rust audio engine. It provides gapless playback, quick library indexing, and a modern aesthetic layout featuring a customizable interface.

### Key Architectural Pillars

* **Local-First & Private:** Viby operates entirely on your machine. There are no tracking scripts, telemetry, or remote dependencies—except for optional Google Font loading.
* **Low Memory Footprint:** By leveraging Tauri 2 instead of Electron, the application frontend runs on the native webview, keeping memory usage minimal.
* **Performance-Driven Audio Pipeline:** Decodes and mixes audio natively in Rust using Symphonia and Rodio, ensuring smooth playback and low latency.
* **Frictionless Search:** Uses an embedded SQLite database with FTS5 (Full-Text Search) to index large libraries (20,000+ tracks) and provide instant search results.

---

## Features

### Playback & Audio
* **Gapless Playback:** Seamless transitions between sequential tracks.
* **Format Support:** Native decoding for MP3, FLAC, WAV, OGG, AAC, M4A, AIFF, and ALAC.
* **Queue Control:** Interactive playback queue with support for shuffle, repeat configurations (off, single track, entire queue), and drag-and-drop reordering.
* **Titlebar Music Visualizer:** Real-time visualizer EQ indicator embedded in the application titlebar, responsive to play/pause states.

### Library & Organization
* **Automatic Directory Scanning:** Monitors and indexes folders containing audio files.
* **Metadata Indexing:** Extracts and displays comprehensive ID3/metadata tags.
* **Playlist Management:** Create, rename, delete, and reorder custom playlists.
* **Quick Search:** Global search launcher (`Ctrl+K` / `Cmd+K`) and dedicated database-backed full-text search across titles, artists, albums, and file attributes.

### UI & Customization
* **Adaptive Theme Picker:** A curated palette of theme colors designed to match modern dark-mode layouts.
* **Custom Window Frames:** Custom native window controls tailored specifically to look integrated on macOS, Windows, and Linux.
* **Toggleable Titlebar Components:** Custom toggles to show/hide the app name and visualizer to achieve a completely minimal look.
* **Typography:** Built-in typography supporting multi-script displays (Latin and Thai).

---

## Technical Stack

| Layer | Component | Description / Purpose |
| --- | --- | --- |
| **Shell & Core** | Tauri v2.0 | Application wrapper, native window management, and system API bridging. |
| **Frontend** | React 19 + TypeScript | Component rendering, layout, and client-side logic. |
| **Styling** | CSS Variables | Custom design tokens and modern layouts without layout utility dependencies. |
| **State** | Zustand | Lightweight, persistent client-side state management. |
| **Audio Engine** | Rodio + Symphonia | Low-latency audio decoding, mixing, and device output streams. |
| **Metadata Parser** | Lofty | Lightweight, pure Rust tag reader for extracting audio metadata. |
| **Database** | SQLite + rusqlite | Local indexing with FTS5 search capability. |
| **Test Runner** | Vitest | Frontend unit tests. |

---

## Getting Started

### Prerequisites

Ensure you have the following installed on your system:
* **Node.js** (v18.0 or newer)
* **Rust compiler** (latest stable release)
* Platform-specific dependencies (such as C compilers and system toolchains). See the [Tauri Prerequisites Guide](https://tauri.app/start/prerequisites/) for your operating system.

### Platform-Specific Backend Dependencies

Developing the Rust backend on Linux requires specific system development libraries:

#### Debian / Ubuntu
```bash
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config libssl-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev libdbus-1-dev libsoup-3.0-dev libudev-dev libcairo2-dev libpango1.0-dev libatk1.0-dev libgdk-pixbuf-2.0-dev
```

#### Arch Linux
```bash
sudo pacman -Syu --needed base-devel curl wget file openssl glib2 webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg alsa-lib dbus libsoup3 cairo pango atk gdk-pixbuf2
```

#### Fedora
```bash
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y curl wget file pkgconf-pkg-config openssl-devel glib2-devel gtk3-devel webkit2gtk4.1-devel libayatana-appindicator-gtk3-devel librsvg2-devel alsa-lib-devel dbus-devel libsoup3-devel libappstream-glib libudev-devel cairo-devel pango-devel atk-devel gdk-pixbuf2-devel
```

### Installation & Development

1. Clone the repository:
   ```bash
   git clone https://github.com/psrisuphan/viby.git
   cd viby
   ```

2. Install the frontend dependencies:
   ```bash
   npm install
   ```

3. Launch the application in development mode (starts Vite server and the Tauri wrapper):
   ```bash
   npm run tauri dev
   ```

---

## Building & Packaging

To compile and pack the application for production, run:
```bash
npm run tauri build
```

This compiles both the React frontend and the Rust backend, bundling them into native installers depending on your platform:
* **macOS:** `.app` bundle, `.dmg` installer
* **Windows:** `.msi` installer, standalone `.exe` executable
* **Linux:** `.deb` package, standalone `AppImage`

The generated installers will be located in: `src-tauri/target/release/bundle/`.

---

## Testing

To run the unit test suites:

```bash
# Execute frontend unit tests via Vitest
npm test

# Execute Rust unit and integration tests
cd src-tauri && cargo test
```

---

## Project Structure

```text
viby/
├── src/                     # React frontend UI
│   ├── components/          # Layout, player, library, and settings modular components
│   ├── stores/              # Zustand stores for state management
│   ├── styles/              # Global CSS declarations and design tokens
│   ├── utils/               # Audio helper utilities and Tauri API communication layers
│   └── types.ts             # Global TypeScript type definitions
├── src-tauri/               # Native Rust application core
│   ├── src/
│   │   ├── audio/           # Rodio stream output and queue processing
│   │   ├── library/         # SQLite schema, migrations, and metadata scanners
│   │   ├── commands/        # Tauri command bindings exposed to the frontend
│   │   ├── error.rs         # Error propagation implementation
│   │   └── lib.rs           # Tauri lifecycle hooks and setup execution
│   └── Cargo.toml           # Rust dependency definitions
├── package.json             # Frontend package configurations and scripts
├── vite.config.ts           # Bundler options
└── tsconfig.json            # TypeScript compiler configuration
```

---

## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for the full license text.

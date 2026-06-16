<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-FFC107?style=for-the-badge&logo=tauri&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/Rust-2024-000000?style=for-the-badge&logo=rust&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-green?style=flat-square" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" />
</p>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/psrisuphan/viby">
    <img src="assets/logo.png" alt="Viby Logo" width="120" height="120">
  </a>

  <h3 align="center">Viby</h3>

  <p align="center">
    <i>VIBY: Viby is beyond your player</i>
  </p>

  <p align="center">
    A modern, high-performance, local-first music player built with Tauri 2, React, and Rust. Focused on speed, clean aesthetics, and offline privacy.
    <br />
    <a href="https://github.com/psrisuphan/viby/releases"><strong>Download Releases »</strong></a>
    <br />
    <br />
    <a href="#getting-started">Getting Started</a>
    &middot;
    <a href="https://github.com/psrisuphan/viby/issues/new?labels=bug&template=bug-report.md">Report Bug</a>
    &middot;
    <a href="https://github.com/psrisuphan/viby/issues/new?labels=enhancement&template=feature-request.md">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#key-architectural-pillars">Key Architectural Pillars</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#features">Features</a>
      <ul>
        <li><a href="#playback--audio">Playback & Audio</a></li>
        <li><a href="#library--organization">Library & Organization</a></li>
        <li><a href="#ui--customization">UI & Customization</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#platform-specific-backend-dependencies">Platform-Specific Backend Dependencies</a></li>
        <li><a href="#installation--development">Installation & Development</a></li>
      </ul>
    </li>
    <li><a href="#building--packaging">Building & Packaging</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#project-structure">Project Structure</a></li>
    <li><a href="#local-data--logs">Local Data & Logs</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

---

<!-- ABOUT THE PROJECT -->
## About The Project

Viby is a lightweight local audio player that combines a responsive React frontend with a robust, multi-threaded Rust audio engine. It provides gapless playback, quick library indexing, and a modern aesthetic layout featuring a customizable interface.

### Key Architectural Pillars

* **Local-First & Private:** Viby operates entirely on your machine. There are no tracking scripts, telemetry, or remote dependencies—except for optional Google Font loading.
* **Low Memory Footprint:** By leveraging Tauri 2 instead of Electron, the application frontend runs on the native webview, keeping memory usage minimal.
* **Performance-Driven Audio Pipeline:** Decodes and mixes audio natively in Rust using Symphonia and Rodio, ensuring smooth playback and low latency.
* **Frictionless Search:** Uses an embedded SQLite database with FTS5 (Full-Text Search) to index large libraries (20,000+ tracks) and provide instant search results.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

Viby is built using modern, fast technologies across the stack:

* **Framework:** [Tauri 2](https://v2.tauri.app/) — Cross-platform desktop shell
* **Frontend:** React 19 + TypeScript — UI components & state
* **Styling:** Vanilla CSS — Custom design system & CSS variables
* **State Management:** Zustand — Persistent client-side state
* **Audio Engine:** Rodio + Symphonia (Rust) — Audio decoding & playback
* **Metadata Parser:** Lofty (Rust) — Metadata tag extraction
* **Database:** SQLite + rusqlite (Rust) — Local library index with FTS5 search

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- FEATURES -->
## Features

### Playback & Audio
* **Gapless Playback:** Seamless transitions between sequential tracks.
* **Format Support:** Native decoding for MP3, FLAC, WAV, OGG, AAC, M4A, AIFF, and ALAC.
* **Queue Control:** Interactive playback queue with support for shuffle, repeat configurations (off, single track, entire queue), and drag-and-drop reordering.
* **Built-in Equalizers:** 10-band Graphic Equalizer and 8-band Parametric Equalizer with custom presets support.
* **AutoEQ Optimization:** Integrated AutoEQ algorithm implemented natively in Rust to generate optimized filter bands for specific headphone models and target response curves.
* **Titlebar Music Visualizer:** Real-time visualizer EQ indicator embedded in the application titlebar, responsive to play/pause states.

### Library & Organization
* **Automatic Directory Scanning:** Monitors and indexes folders containing audio files.
* **Metadata Indexing:** Extracts and displays comprehensive ID3/metadata tags.
* **Playlist Management:** Create, rename, delete, and reorder custom playlists.
* **Quick Search:** Global search launcher (`Ctrl+K` / `Cmd+K`) and dedicated database-backed full-text search across titles, artists, albums, and file attributes.
* **Discord Rich Presence:** Integrates Discord RPC to show your currently playing song status directly on your profile.

### UI & Customization
* **Adaptive Theme Picker:** A curated palette of theme colors designed to match modern dark-mode layouts.
* **Custom Window Frames:** Custom native window controls tailored specifically to look integrated on macOS, Windows, and Linux.
* **Toggleable Titlebar Components:** Custom toggles to show/hide the app name and visualizer to achieve a completely minimal look.
* **Typography:** Built-in typography supporting multi-script displays (Latin and Thai).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- GETTING STARTED -->
## Getting Started

To get a local copy up and running, follow these steps.

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

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- BUILDING -->
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

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TESTING -->
## Testing

To run the unit test suites:

```bash
# Execute frontend unit tests via Vitest
npm test

# Execute Rust unit and integration tests
cd src-tauri && cargo test
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- PROJECT STRUCTURE -->
## Project Structure

```text
viby/
├── assets/                  # Public asset resources (branding/logos)
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

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- LOCAL DATA & LOGS -->
## Local Data & Logs

Viby stores application databases, configuration files, and playback logs locally. Depending on your operating system, these files can be found in the following directories:

* **macOS:** `~/Library/Application Support/com.viby.app/`
* **Windows:** `%APPDATA%\com.viby.app\` (resolves to `C:\Users\<Username>\AppData\Roaming\com.viby.app\`)
* **Linux:** `~/.local/share/com.viby.app/` or `$XDG_DATA_HOME/com.viby.app/`

Inside these directories, you will find:
* `viby.db` — SQLite database holding track metadata, playlists, and settings.
* `gpu_settings.json` — Hardware rendering configuration file.
* `discord_artwork_cache.json` — Cached lookup file for Discord RPC rich presence artwork.
* `logs/` — Directory containing runtime debug logs.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- LICENSE -->
## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for the full license text.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* Made with ❤️ by [psrisuphan](https://github.com/psrisuphan), [Bukutsu](https://github.com/Bukutsu), and other contributors.
* [Vinyl icons](https://www.flaticon.com/free-icons/vinyl) created by Those Icons - Flaticon.
* AutoEQ optimization logic referenced from the [autoeq-c](https://github.com/peqdb/autoeq-c/) library.
* Special thanks to the developers of [Tauri](https://tauri.app/), [Symphonia](https://github.com/pdeljanov/Symphonia), and [Rodio](https://github.com/RustAudio/rodio).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

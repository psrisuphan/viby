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
# Clone the repo
git clone https://github.com/psrisuphan/viby.git
cd viby

# Install frontend dependencies
npm install

# Start development
npm run tauri dev
```

This will:
1. Start the Vite dev server (frontend) at `localhost:1420`
2. Compile the Rust backend
3. Launch the Tauri window with hot-reload

## Project Structure

```
viby/
├── src/                        # Frontend (React + TypeScript)
│   ├── components/             # UI components
│   │   ├── layout/             # Titlebar, Sidebar, PlayerBar, AppLayout
│   │   ├── library/            # SongTable, AlbumGrid, ArtistList
│   │   ├── player/             # NowPlaying, Controls, ProgressBar
│   │   ├── playlist/           # PlaylistPanel, PlaylistEditor
│   │   ├── search/             # SearchModal
│   │   └── common/             # Shared components (Button, Slider, Modal)
│   ├── stores/                 # Zustand state stores
│   ├── styles/                 # CSS design system
│   ├── utils/                  # Helpers and Tauri IPC wrappers
│   └── types.ts                # Shared TypeScript types
├── src-tauri/                  # Backend (Rust)
│   ├── src/
│   │   ├── audio/              # Audio engine (rodio + symphonia)
│   │   ├── library/            # Scanner, metadata, SQLite DB
│   │   ├── commands/           # Tauri command handlers
│   │   ├── models.rs           # Shared Rust types
│   │   ├── lib.rs              # App entry + command registration
│   │   └── main.rs             # Process entry point
│   ├── capabilities/           # Tauri 2 permissions
│   ├── Cargo.toml              # Rust dependencies
│   └── tauri.conf.json         # Tauri configuration
├── docs/                       # Documentation
├── package.json                # Frontend config
├── vite.config.ts              # Build config
└── tsconfig.json               # TypeScript config
```

## Useful Commands

| Command | Description |
|---|---|
| `npm run tauri dev` | Start dev mode (frontend + backend) |
| `npm run tauri build` | Build production bundle |
| `npm run dev` | Start Vite dev server only (no Tauri) |
| `cd src-tauri && cargo test` | Run Rust unit tests |
| `cd src-tauri && cargo clippy` | Run Rust linter |

## Adding a New Tauri Command

1. Define the function in `src-tauri/src/commands/`:
   ```rust
   #[tauri::command]
   pub async fn my_command(param: String) -> Result<String, String> {
       Ok(format!("Hello {}", param))
   }
   ```

2. Register it in `src-tauri/src/lib.rs`:
   ```rust
   .invoke_handler(tauri::generate_handler![
       // ... existing commands
       commands::my_module::my_command,
   ])
   ```

3. Call it from the frontend:
   ```typescript
   const result = await invoke<string>('my_command', { param: 'World' });
   ```

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

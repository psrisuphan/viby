# Development workflow

This guide covers the checks and review steps used for changes to Viby. Follow the platform prerequisites in [README.md](README.md#platform-specific-backend-dependencies) before building the native app.

## Set up

From the repository root, install the locked frontend dependencies:

```bash
npm ci
```

For the desktop application, install the Rust stable toolchain and the system packages required by Tauri for your operating system. Start the native app with:

```bash
npm run tauri dev
```

## Make a reviewable change

- Start from an up-to-date checkout and use a dedicated branch for each task.
- Keep commits focused on that task. Include the base and head commit IDs when handing work to a reviewer.
- Do not commit directly to `main` or merge changes before review.
- Stage only the files that belong to the task. Check `git status` before committing.
- `AGENTS.md` is intentionally local-only and ignored. Do not force-add it or change that policy. Put team-shared procedures in tracked files such as this guide.

## Frontend checks

Run these from the repository root:

```bash
npm test
npm run build
```

For a rendered UI check, start the browser-test build:

```bash
npm run dev:browser -- --host 127.0.0.1 --port 1429
```

On Windows, the `dev:browser` script's POSIX environment assignment will not work in the default shell. In PowerShell, run:

```powershell
$env:VIBY_BROWSER_TEST = "1"
npm run dev -- --host 127.0.0.1 --port 1429
```

In Command Prompt, run:

```bat
set VIBY_BROWSER_TEST=1
npm run dev -- --host 127.0.0.1 --port 1429
```

Open `http://127.0.0.1:1429/?route=home` or a focused route such as `?route=library:songs`, `?route=settings:shortcuts`, or `?route=peq`. Check the normal desktop size and the configured minimum window size (`960 × 680` in `src-tauri/tauri.conf.json`). Keyboard-check changed interactions and save screenshots for layout changes.

The browser-test build uses browser shims for native APIs. It can verify rendered frontend states and keyboard behavior, but it does not verify native window transitions, audio output, file reveal, or other operating-system behavior. Use the native application for those checks.

## Rust checks

Run Rust commands from the repository root with the manifest path:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

Run the test and lint checks for changes to backend behavior. Report platform-specific checks that were not available in the current environment.

## Diagnostics and generated files

Use the appropriate log level and keep diagnostics useful without exposing local file paths, library names, or other private user data. Build output, dependencies, and local instructions are ignored; inspect `git status --ignored` before any cleanup. Do not remove ignored or untracked files unless they were created by the current task and are no longer needed.

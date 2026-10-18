# Cargo dependency audit

The manifest review at base `22391a29` found two identical `tauri` declarations
for macOS and non-macOS targets. Their common features now live in one
`[dependencies]` declaration. `macos-private-api` stays enabled in that shared
declaration because `tauri.conf.json` sets `macOSPrivateApi`, and `tauri-build`
checks the feature allowlist on the root dependency declaration. The original
manifest enabled this feature on every target; this cleanup preserves that
feature graph. The macOS-only `cocoa` and Linux-only GTK, zbus, and WebKit
dependencies remain target-specific.

The three suspected audio dependencies are all used directly and remain:

- `rodio`: output streams, sinks, and the `Source` interface across
  `audio/output.rs`, `audio/session.rs`, `audio/runtime.rs`, `audio/decoder.rs`,
  `audio/eq.rs`, and `audio/normalization.rs`.
- `symphonia`: format probing, codec selection, packet decoding, and seeking in
  `audio/decoder.rs`.
- `cpal`: host/device enumeration and output configuration in `audio/output.rs`.

The remaining direct dependencies were also matched against their Rust crate
imports in `src-tauri/src` and `src-tauri/build.rs`; no unused direct
dependency was removed. `cargo-machete` is not installed in this environment,
so this was a source/import audit rather than an automated unused-dependency
scan.

Feature-graph checks use `cargo tree -e features -i tauri` for
`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, and
`x86_64-pc-windows-msvc`. These confirm the same shared feature set on each
target. Native macOS check passed with the shared release cache:

```sh
CARGO_TARGET_DIR=/Users/psrisuphan/OpenBot/Shared/viby-remediation/worktrees/t03-panic-recovery/src-tauri/target cargo check --locked --offline --release --manifest-path src-tauri/Cargo.toml --lib
```

Linux and Windows release builds remain CI matrix checks.

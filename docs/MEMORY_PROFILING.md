# Memory profiling

Measurements for `perf/webview-memory-optimization`, collected on 2026-07-20 for a future PR.

## Environment

- Linux 7.1.4-1-cachyos x86_64, Wayland, niri
- WebKitGTK 2.52.5
- Tauri CLI 2.11.2
- Rust 1.96.1; Node.js 24.18.0
- Library: 694 tracks / 165 albums
- GPU acceleration enabled; normal 1280×800 window
- Artwork corpus: 96 cached covers, 32 MiB compressed, 628.2 MiB estimated if all originals decode to RGBA

## Method

Release measurements used `npm run tauri build -- --no-bundle`, launched `src-tauri/target/release/viby`, waited 30 seconds on the home screen, then summed proportional set size (PSS) from `/proc/<pid>/smaps_rollup` for Viby, `WebKitWebProcess`, and `WebKitNetworkProcess`.

Development measurements launched the complete `npm` process tree, waited at least 30 seconds after `target/debug/viby` started, and included npm, Tauri CLI, Vite, esbuild, Viby, and WebKit processes. The optimized standard-dev result is the second warm run; the first run rebuilt Vite's dependency cache and was transiently 1,012.0 MiB PSS.

PSS is used instead of adding RSS because WebKit processes share mapped pages. Results are single-host snapshots, not cross-platform guarantees.

## Release results

| Stage | Viby | WebKit renderer | WebKit network | Total PSS | Change |
|---|---:|---:|---:|---:|---:|
| Original `bdf3fb5` | 98.1 MiB | 483.0 MiB | 35.4 MiB | **616.5 MiB** | — |
| Covers capped globally at 768 px | 119.0 MiB | 259.3 MiB | 35.0 MiB | **413.3 MiB** | -33.0% |
| Size-aware 128/384/768 px covers (`c6c9fa1`) | 109.1 MiB | 215.5 MiB | 39.9 MiB | **364.5 MiB** | **-40.9%** |
| Empty library, same build/GPU setting | 94.0 MiB | 201.2 MiB | 39.7 MiB | **334.9 MiB** | floor reference |

The final renderer reduction is 55.4%. The real library now adds only about 29 MiB over the empty-library process tree; most remaining usage is WebKitGTK's accelerated-compositing baseline.

Artwork dimensions match rendered size at 2× scale:

- 128 px: rows, queue, search results, player bar
- 384 px: cards up to 192 CSS px
- 768 px: fullscreen/detail artwork up to 380 CSS px

No CSS, layout, animation, or transparency changes are part of the result.

## Development results

| Mode | Main differences | Total PSS | Change vs original dev |
|---|---|---:|---:|
| Original `tauri dev` | Vite + HMR + React compiler in serve path | **974.7 MiB** | — |
| Optimized `tauri dev` | React compiler remains for builds, skipped while serving | **755.3 MiB** | **-22.5%** |
| `npm run dev:low-memory` | Production frontend; no Vite/HMR or Rust watcher | **478.9 MiB** | **-50.9%** |

Raw steady-state development process breakdowns:

- Original dev: Vite 414.5, WebKit renderer 237.6, Viby 123.8, Tauri CLI 59.9, network 42.2, esbuild 32.2, npm 64.5 MiB PSS.
- Optimized dev: Vite 211.5, WebKit renderer 238.5, Viby 119.2, Tauri CLI 59.9, network 42.2, esbuild 20.0, npm 64.1 MiB PSS.
- Low-memory dev: WebKit renderer 208.8, Viby 124.2, Tauri CLI 65.1, network 40.8, npm 40.0 MiB PSS.

`dev:low-memory` preserves the production UI but deliberately trades away HMR and automatic Rust rebuilds; restart it after edits.

## Rejected experiments

These changes were reverted and should not be included in the PR:

- Removing persistent CSS `will-change` hints: total PSS increased from 413.3 to about 444.7 MiB in the comparable 768 px artwork stage, with possible animation regressions.
- WebKitGTK `DocumentViewer` cache model: real-library trials were 382.5 and 366.5 MiB versus the 364.5 MiB control, so there was no repeatable benefit.
- Disabling GPU compositing reduced memory but also disabled glass/backdrop effects, violating the visual requirement.

## References

- [Tauri debug builds and devtools](https://v2.tauri.app/develop/debug/)
- [Tauri `devUrl` / `frontendDist` configuration](https://v2.tauri.app/reference/config/)
- [WebKit memory inspection](https://docs.webkit.org/Infrastructure/MemoryInspection.html)
- [MDN: use `will-change` sparingly](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)

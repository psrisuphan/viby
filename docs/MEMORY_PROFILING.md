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

Release measurements used `npm run tauri build -- --no-bundle`, launched `src-tauri/target/release/viby`, waited 30 seconds on the home screen, then summed proportional set size (PSS) from `/proc/<pid>/smaps_rollup` for Viby, `WebKitWebProcess`, and `WebKitNetworkProcess`. Deep-profile results use the median of three runs and `/proc/<pid>/smaps` for mapping categories.

Development measurements launched the complete `npm` process tree, waited at least 30 seconds after `target/debug/viby` started, and included npm, Tauri CLI, Vite, esbuild, Viby, and WebKit processes. The optimized standard-dev result is the second warm run; the first run rebuilt Vite's dependency cache and was transiently 1,012.0 MiB PSS.

PSS is used instead of adding RSS because WebKit processes share mapped pages. Results are single-host snapshots, not cross-platform guarantees.

## Release results

| Stage | Viby | WebKit renderer | WebKit network | Total PSS | Change |
|---|---:|---:|---:|---:|---:|
| Historical pre-artwork baseline `bdf3fb5` | 98.1 MiB | 483.0 MiB | 35.4 MiB | **616.5 MiB** | historical |
| PR base `83ebd80` (includes #181 artwork work; 3-run median) | 108.2 MiB | 225.3 MiB | 38.5 MiB | **372.1 MiB** | — |
| This branch after glibc tuning and remaining size hints (3-run median) | 92.1 MiB | 214.6 MiB | 38.2 MiB | **343.8 MiB** | **-7.6% vs base** |
| Empty library, this branch | 81.7 MiB | 198.7 MiB | 38.1 MiB | **318.5 MiB** | floor reference |

The rebased branch saves 28.3 MiB over current `main`, and 44.2% versus the historical pre-artwork baseline. The real library adds about 25 MiB over the empty-library process tree; most remaining usage is WebKitGTK's fixed engine/compositor baseline.

PR #181 now provides the core size-aware artwork pipeline. This branch fills the remaining call-site hints so dimensions match rendered size at 2× scale:

- 128 px: small top-artist artwork
- 384 px: default cards up to 192 CSS px
- 768 px: spotlight, mini-player, and album/artist detail artwork up to 380 CSS px

No CSS, layout, animation, or transparency changes are part of the result.

### Deep release breakdown

Before allocator tuning, `/proc/<pid>/smaps` attributed the release processes as follows:

- WebKit renderer (~215 MiB): 109.4 MiB anonymous mappings, 44.0 MiB WebKit code/data, 22.2 MiB other shared libraries, 19.9 MiB JavaScriptCore code/data, 9.0 MiB heap, and 4.0 MiB fonts.
- Viby (~109 MiB): 44.5 MiB heap, 19.7 MiB anonymous mappings, 17.2 MiB shared libraries, 10.9 MiB application binary, 10.3 MiB WebKit code/data, and 5.3 MiB JavaScriptCore code/data.
- Network process (~39 MiB): 10.8 MiB anonymous mappings, 9.3 MiB shared libraries, 8.5 MiB heap, 8.3 MiB WebKit code/data, and 2.2 MiB JavaScriptCore code/data.

`JSC_logGC=2` showed only about 2.9 MiB live JavaScript after a full collection, despite a roughly 31 MiB pre-collection heap. The frontend object graph is therefore not the main remaining consumer; most renderer memory is engine allocation regions and mapped code.

On this 32 GiB host, glibc's default arena count and dynamically rising trim threshold retained temporary image/WebKit allocation bursts. Limiting the process family to eight arenas and fixing the trim threshold at 128 KiB reduced median release PSS by 28.3 MiB versus rebased `main`, without increasing 30-second startup CPU time. Existing user-provided allocator settings take precedence.

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
- Forcing JavaScriptCore's non-aggressive growth policy or a 16 MiB minimum heap produced no repeatable benefit.
- Disabling JavaScriptCore DFG/FTL tiers saved roughly 10–20 MiB, but uses internal environment switches and risks long-session UI throughput, so it was not shipped.

## References

- [Tauri debug builds and devtools](https://v2.tauri.app/develop/debug/)
- [Tauri `devUrl` / `frontendDist` configuration](https://v2.tauri.app/reference/config/)
- [WebKit memory inspection](https://docs.webkit.org/Infrastructure/MemoryInspection.html)
- [MDN: use `will-change` sparingly](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)
- [glibc malloc tunables](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html)
- [JavaScriptCore heap defaults](https://github.com/WebKit/WebKit/blob/1cc5dfa320db9ecf0bf3fbb27fb291398b7bf1fa/Source/JavaScriptCore/runtime/OptionsList.h#L215-L230)
- [JavaScriptCore aggressive growth policy](https://github.com/WebKit/WebKit/blob/1cc5dfa320db9ecf0bf3fbb27fb291398b7bf1fa/Source/JavaScriptCore/heap/Heap.cpp#L140-L176)
- [Wry's WebKitGTK context construction](https://github.com/tauri-apps/wry/blob/a93d04c9088beb7541597bdaedd581937bac6e1f/src/webkitgtk/web_context.rs#L31-L50)

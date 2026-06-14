import { useEffect, useRef, useCallback, Profiler } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
	getCurrentWindow,
	LogicalSize,
	type PhysicalSize,
	type PhysicalPosition,
} from "@tauri-apps/api/window";

const isLinux = navigator.userAgent.toLowerCase().includes("linux");
import { listen } from "@tauri-apps/api/event";
import { useUiStore } from "./stores/uiStore";
import { usePlayerStore } from "./stores/playerStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useThemeStore, applyTheme } from "./stores/themeStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useQueueStore } from "./stores/queueStore";
import {
	onPlaybackStateChange,
	onScanProgress,
	getAllTracks,
	getAlbums,
	getArtists,
	getPlaylists,
	setVolume as setRustVolume,
	setShuffle as setRustShuffle,
	setRepeat as setRustRepeat,
	setEq,
	setPeq,
	getGpuAcceleration,
	getQueue,
	onQueueChanged,
	onQueuePositionChanged,
	onTrackEnded,
	nextTrack,
	previousTrack,
	pausePlayback,
	resumePlayback,
	seekTo,
} from "./utils/tauri";

// Global Styles
import "./styles/design-tokens.css";
import "./styles/themes.css";
import "./styles/reset.css";
import "./styles/globals.css";
import "./styles/animations.css";
import "./App.css";
import { logProfileEvent } from "./utils/profiler";

// Components
import Titlebar from "./components/layout/Titlebar";
import Sidebar from "./components/layout/Sidebar";
import PlayerBar from "./components/layout/PlayerBar";
import LibraryView from "./components/library/LibraryView";
import SearchModal from "./components/search/SearchModal";
import QueuePanel from "./components/player/QueuePanel";
import FullscreenPlayer from "./components/player/FullscreenPlayer";
import MiniPlayer from "./components/player/MiniPlayer";
import ToastContainer from "./components/ui/ToastContainer";
import PlaylistView from "./components/playlist/PlaylistView";

function playbackDebugEnabled() {
	return (
		import.meta.env.DEV || localStorage.getItem("vibyDebugPlayback") === "1"
	);
}

type ResizeDirection =
	| "North"
	| "South"
	| "East"
	| "West"
	| "NorthEast"
	| "NorthWest"
	| "SouthEast"
	| "SouthWest";

const resizeDirections: ResizeDirection[] = [
	"North",
	"South",
	"East",
	"West",
	"NorthEast",
	"NorthWest",
	"SouthEast",
	"SouthWest",
];

function WindowResizeHandles() {
	const handlePointerDown =
		(direction: ResizeDirection) =>
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			getCurrentWindow()
				.startResizeDragging(direction)
				.catch((err) =>
					console.error(`Failed to start ${direction} resize:`, err),
				);
		};

	return (
		<div className="window-resize-handles" aria-hidden="true">
			{resizeDirections.map((direction) => (
				<div
					key={direction}
					className={`window-resize-handle window-resize-handle--${direction.toLowerCase()}`}
					onPointerDown={handlePointerDown(direction)}
				/>
			))}
		</div>
	);
}

function App() {
	const {
		isTheaterMode,
		isMiniPlayerOpen,
		setMiniPlayerOpen,
		isQueueOpen,
		isSearchOpen,
		activeSection,
	} = useUiStore();
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const theme = useThemeStore((s) => s.theme);

	// Apply saved theme on mount and whenever it changes
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);
	const setPlaybackSnapshot = usePlayerStore((s) => s.setPlaybackSnapshot);
	const { setTracks, setAlbums, setArtists, setScanState, setPlaylists } =
		useLibraryStore();
	const { setQueueState, setCurrentIndex } = useQueueStore();
	const unlistenFnsRef = useRef<Array<() => void>>([]);

	const savedWindowState = useRef<{
		size: PhysicalSize;
		position: PhysicalPosition | null;
	} | null>(null);

	useEffect(() => {
		if (!playbackDebugEnabled()) return;

		console.info("[VibyDebug] UI hang watchdog enabled");

		let lastTick = performance.now();
		const interval = window.setInterval(() => {
			const now = performance.now();
			const stallMs = now - lastTick - 1000;
			if (stallMs > 1000) {
				const player = usePlayerStore.getState();
				const queue = useQueueStore.getState();
				console.warn("[VibyDebug] UI event loop stall", {
					stalled_ms: Math.round(stallMs),
					current_track: player.currentTrack?.title ?? null,
					position_secs: Number(player.positionSecs.toFixed(2)),
					queue_len: queue.tracks.length,
					current_index: queue.currentIndex,
				});
			}
			lastTick = now;
		}, 1000);

		return () => window.clearInterval(interval);
	}, []);

	const enterMiniPlayer = useCallback(async () => {
		const win = getCurrentWindow();
		try {
			const size = await win.innerSize();
			const position = !isLinux ? await win.outerPosition() : null;
			savedWindowState.current = { size, position };
			await win.setResizable(false);
			await win.setSize(new LogicalSize(420, isLinux ? 165 : 200));
			await win.setAlwaysOnTop(
				useSettingsStore.getState().miniPlayerAlwaysOnTop,
			);
			if (!isLinux) await win.center();
		} catch (e) {
			console.error("Mini player window resize failed:", e);
		}
		setMiniPlayerOpen(true);
	}, [setMiniPlayerOpen]);

	const exitMiniPlayer = useCallback(async () => {
		const win = getCurrentWindow();
		setMiniPlayerOpen(false);
		try {
			await win.setAlwaysOnTop(false);
			await win.setResizable(true);
			if (savedWindowState.current) {
				await win.setSize(savedWindowState.current.size);
				if (!isLinux && savedWindowState.current.position) {
					await win.setPosition(savedWindowState.current.position);
				}
			}
		} catch (e) {
			console.error("Mini player expand failed:", e);
		}
	}, [setMiniPlayerOpen]);

	const loadLibraryData = async () => {
		try {
			const [tracks, albums, artists, playlists] = await Promise.all([
				getAllTracks(),
				getAlbums(),
				getArtists(),
				getPlaylists(),
			]);
			setTracks(tracks);
			setAlbums(albums);
			setArtists(artists);
			setPlaylists(playlists);
		} catch (e) {
			console.error("Failed to load library data:", e);
		}
	};

	useEffect(() => {
		let cancelled = false;

		const setup = async () => {
			loadLibraryData();

			// Sync persisted player state to the Rust backend
			const state = usePlayerStore.getState();
			await setRustVolume(state.volume);
			await setRustShuffle(state.shuffle);
			await setRustRepeat(state.repeatMode);

			const eq = useSettingsStore.getState();
			await invoke("set_close_to_tray", { enabled: eq.closeToTray }).catch(
				(err) => console.error("Failed to sync closeToTray on startup:", err),
			);
			await invoke("set_discord_rpc_enabled", {
				enabled: eq.discordRpcEnabled,
			}).catch((err) =>
				console.error("Failed to sync Discord RPC setting on startup:", err),
			);
			await getGpuAcceleration()
				.then((enabled) =>
					useSettingsStore.getState().setGpuAccelerationLocal(enabled),
				)
				.catch((err) =>
					console.error("Failed to sync GPU acceleration setting:", err),
				);

			// Sync persisted equalizer settings so the backend matches saved state
			// even before the user opens the EQ tab.
			if (eq.eqMode === "parametric") {
				await setPeq(
					eq.eqEnabled,
					eq.eqPreamp,
					eq.peqBands.map((band) => ({
						enabled: band.enabled,
						filter_type: band.filterType,
						freq: band.freq,
						gain: band.gain,
						q: band.q,
					})),
				);
			} else {
				await setEq(eq.eqEnabled, eq.eqPreamp, eq.eqGains);
			}

			try {
				const q = await getQueue();
				if (!cancelled) setQueueState(q);
			} catch (e) {
				console.error("Failed to fetch initial queue", e);
			}

			// Auto-scan library on app launch to catch new music
			invoke("scan_library").catch((err) =>
				console.error("Auto-scan failed:", err),
			);

			// Register all event listeners and store the resolved unlisten functions
			// so cleanup is always synchronous (no promise race on unmount).
			const debugPlayback = playbackDebugEnabled();
			let playbackEventCount = 0;
			let lastPlaybackLog = performance.now();
			let lastPlaybackTrackId: string | null = null;

			// Debounce playback-state updates into rAF to avoid flooding WebKit
			// with re-renders during rapid state changes (skip, spam-click), which
			// triggers GPU driver crashes on some Mesa/GBM configurations.
			let pendingPlaybackSnapshot:
				| Parameters<typeof setPlaybackSnapshot>[0]
				| null = null;
			let playbackRafId: number | null = null;

			const fns = await Promise.all([
				listen("tray-open", () => {
					if (!cancelled) enterMiniPlayer();
				}),
				onPlaybackStateChange((s) => {
					if (cancelled) return;
					const currentTrackId = usePlayerStore.getState().currentTrack?.id;
					const newTrackId = s.current_track?.id;
					logProfileEvent('tauri_event', `onPlaybackStateChange: newTrackId=${newTrackId}, isPlaying=${s.is_playing}, pos=${s.position_secs.toFixed(2)}s`);
					// Don't debounce track changes — they must be immediate for UI correctness
					if (newTrackId && newTrackId !== currentTrackId) {
						// Track changed: flush any pending and apply immediately
						if (playbackRafId !== null) {
							cancelAnimationFrame(playbackRafId);
							playbackRafId = null;
						}
						pendingPlaybackSnapshot = null;
						setPlaybackSnapshot(s);
						return;
					}
					// Position-only update: debounce into animation frame
					pendingPlaybackSnapshot = s;
					if (playbackRafId === null) {
						playbackRafId = requestAnimationFrame(() => {
							playbackRafId = null;
							if (pendingPlaybackSnapshot && !cancelled) {
								setPlaybackSnapshot(pendingPlaybackSnapshot);
								pendingPlaybackSnapshot = null;
							}
						});
					}
					if (debugPlayback) {
						playbackEventCount += 1;
						const now = performance.now();
						const trackId = s.current_track?.id ?? null;
						const trackChanged = trackId !== lastPlaybackTrackId;
						if (trackChanged || now - lastPlaybackLog >= 1000) {
							console.info("[VibyDebug] playback-state", {
								events_since_last_log: playbackEventCount,
								is_playing: s.is_playing,
								current_track: s.current_track?.title ?? null,
								position_secs: Number(s.position_secs.toFixed(2)),
							});
							playbackEventCount = 0;
							lastPlaybackLog = now;
							lastPlaybackTrackId = trackId;
						}
					}
					// Shuffle and repeat are NOT synced from playback-state events —
					// the audio thread hardcodes them to false/off. Initial sync and
					// user actions keep those fields correct instead.
				}),
				onScanProgress((progress) => {
					if (cancelled) return;
					const percent =
						progress.total_files > 0
							? (progress.processed_files / progress.total_files) * 100
							: 0;
					setScanState(
						progress.status !== "complete" && progress.status !== "error",
						percent,
						progress.status === "scanning"
							? `Scanning: ${progress.current_file}`
							: progress.status,
					);
					// Only reload library data if the scan actually changed something
					if (progress.status === "complete") {
						const changed =
							(progress.new_tracks ?? 0) > 0 ||
							(progress.removed_tracks ?? 0) > 0;
						if (changed) loadLibraryData();
					}
				}),
				onQueueChanged((payload) => {
					if (cancelled) return;
					logProfileEvent('tauri_event', `onQueueChanged: tracksCount=${payload.tracks.length}, current_index=${payload.current_index}`);
					const started = performance.now();
					setQueueState(payload);
					if (debugPlayback) {
						console.info("[VibyDebug] queue-changed", {
							tracks: payload.tracks.length,
							current_index: payload.current_index,
							handler_ms: Number((performance.now() - started).toFixed(2)),
						});
					}
				}),
				onQueuePositionChanged((payload) => {
					if (cancelled) return;
					logProfileEvent('tauri_event', `onQueuePositionChanged: current_index=${payload.current_index}`);
					const started = performance.now();
					setCurrentIndex(payload.current_index);
					if (debugPlayback) {
						console.info("[VibyDebug] queue-position-changed", {
							current_index: payload.current_index,
							queue_len: useQueueStore.getState().tracks.length,
							handler_ms: Number((performance.now() - started).toFixed(2)),
						});
					}
				}),
				onTrackEnded(() => {
					if (!cancelled) {
						logProfileEvent('tauri_event', 'onTrackEnded - auto advance');
						nextTrack(false).catch((e) =>
							console.error("Auto advance failed:", e),
						);
					}
				}),
			]);

			if (!cancelled) {
				unlistenFnsRef.current = fns;
			} else {
				fns.forEach((fn) => fn());
			}
		};

		setup();

		return () => {
			cancelled = true;
			unlistenFnsRef.current.forEach((fn) => fn());
			unlistenFnsRef.current = [];
		};
	}, []);

	useEffect(() => {
		const handleGlobalKeys = async (e: KeyboardEvent) => {
			const activeEl = document.activeElement;
			const isInput =
				activeEl && ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName);

			const isMac = navigator.userAgent.toLowerCase().includes("mac");
			const isModKey = isMac ? e.metaKey : e.ctrlKey;

			// Toggle search modal on Ctrl+K / Cmd+K
			if (isModKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				const { isSearchOpen, setSearchOpen } = useUiStore.getState();
				setSearchOpen(!isSearchOpen);
				return;
			}

			// Exit App on Ctrl+Q / Cmd+Q (fallback if OS window manager doesn't capture it)
			if (isModKey && e.key.toLowerCase() === "q") {
				e.preventDefault();
				await invoke("exit_app").catch((err) =>
					console.error("Failed to exit app:", err),
				);
				return;
			}

			// If typing in an input, don't trigger playback controls
			if (isInput) return;

			// Play/Pause on Space
			if (e.key === " ") {
				e.preventDefault();
				const { isPlaying, currentTrack } = usePlayerStore.getState();
				if (currentTrack) {
					if (isPlaying) {
						await pausePlayback().catch((err) =>
							console.error("Failed to pause:", err),
						);
					} else {
						await resumePlayback().catch((err) =>
							console.error("Failed to resume:", err),
						);
					}
				}
			}

			// Playback arrow navigation
			if (isModKey) {
				if (e.key === "ArrowRight") {
					e.preventDefault();
					await nextTrack(true).catch((err) =>
						console.error("Failed to skip next:", err),
					);
				} else if (e.key === "ArrowLeft") {
					e.preventDefault();
					const { positionSecs } = usePlayerStore.getState();
					if (positionSecs > 3) {
						await seekTo(0).catch((err) =>
							console.error("Failed to seek:", err),
						);
					} else {
						await previousTrack(true).catch((err) =>
							console.error("Failed to skip previous:", err),
						);
					}
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					const currentVol = usePlayerStore.getState().volume;
					const newVol = Math.min(1, currentVol + 0.05);
					usePlayerStore.getState().setVolume(newVol);
					await setRustVolume(newVol).catch((err) =>
						console.error("Failed to change volume:", err),
					);
				} else if (e.key === "ArrowDown") {
					e.preventDefault();
					const currentVol = usePlayerStore.getState().volume;
					const newVol = Math.max(0, currentVol - 0.05);
					usePlayerStore.getState().setVolume(newVol);
					await setRustVolume(newVol).catch((err) =>
						console.error("Failed to change volume:", err),
					);
				}
			}
		};

		window.addEventListener("keydown", handleGlobalKeys);
		return () => {
			window.removeEventListener("keydown", handleGlobalKeys);
		};
	}, []);

	const onRenderProfiler = (
		id: string,
		phase: "mount" | "update" | "nested-update",
		actualDuration: number,
		baseDuration: number
	) => {
		if (phase === "mount" || actualDuration > 3) {
			logProfileEvent("render", `${id} render (${phase}) took ${actualDuration.toFixed(2)}ms`, {
				actualDuration,
				baseDuration,
			});
		}
	};

	const content = (
		<div
			className={`app-container ${isTheaterMode ? "theater-mode" : ""} ${isMiniPlayerOpen ? "mini-player-mode" : ""}`}
		>
			{!isMiniPlayerOpen && <WindowResizeHandles />}
			{isMiniPlayerOpen && <MiniPlayer onExpand={exitMiniPlayer} />}

			{!isMiniPlayerOpen && !isTheaterMode && (
				<>
					<Titlebar />
					<div className="main-content">
						<Sidebar />
						<div className="content-wrapper">
							<div className="content-row">
								<main className="content-area">
									{activeSection === "playlist" ? (
										<PlaylistView />
									) : (
										<LibraryView />
									)}
								</main>
								{isQueueOpen && <QueuePanel />}
							</div>
							{currentTrack && <PlayerBar onMiniPlayer={enterMiniPlayer} />}
						</div>
					</div>
				</>
			)}

			{!isMiniPlayerOpen && isTheaterMode && <FullscreenPlayer />}
			{isSearchOpen && <SearchModal />}
			<ToastContainer />
		</div>
	);

	if (import.meta.env.DEV) {
		return (
			<Profiler id="App" onRender={onRenderProfiler}>
				{content}
			</Profiler>
		);
	}

	return content;
}

export default App;

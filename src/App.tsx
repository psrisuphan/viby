import { Suspense, lazy, useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
	getCurrentWindow,
	LogicalSize,
	type PhysicalSize,
	type PhysicalPosition,
} from "@tauri-apps/api/window";

import { getPlatform } from "./utils/platform";
import { listen } from "@tauri-apps/api/event";
import { useUiStore } from "./stores/uiStore";
import { usePlayerStore } from "./stores/playerStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useThemeStore, applyTheme, getThemeAccent } from "./stores/themeStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useQueueStore } from "./stores/queueStore";
import { applyThemeRuntimeIcon } from "./utils/runtimeIcon";
import { isAutoScanDue } from "./utils/scanCadence";
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
	setSoundCheckEnabled,
	setSoundCheckTargetLufs,
	analyzeMissingNormalization,
	setEq,
	setPeq,
	getGpuAcceleration,
	setBackgroundAppEnabled,
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


const isLinux = getPlatform() === "linux";
const NORMAL_MIN_WINDOW_SIZE = new LogicalSize(960, 680);
const MINI_PLAYER_MIN_WINDOW_SIZE = new LogicalSize(420, isLinux ? 165 : 200);
const LAST_AUTO_SCAN_KEY = "viby-last-auto-scan";

// Components
import Titlebar from "./components/layout/Titlebar";
import Sidebar from "./components/layout/Sidebar";
import PlayerBar from "./components/layout/PlayerBar";
import LibraryView from "./components/library/LibraryView";
import ToastContainer from "./components/ui/ToastContainer";
import type { BrowserTestRoute } from "./browser-test/routes";

const SearchModal = lazy(() => import("./components/search/SearchModal"));
const QueuePanel = lazy(() => import("./components/player/QueuePanel"));
const FullscreenPlayer = lazy(() => import("./components/player/FullscreenPlayer"));
const MiniPlayer = lazy(() => import("./components/player/MiniPlayer"));
const PlaylistView = lazy(() => import("./components/playlist/PlaylistView"));

function getInitialBrowserTestRoute(): BrowserTestRoute | null {
	return null;
}

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

function resizeDirectionsForPlatform(directions: ResizeDirection[]) {
	const platform = getPlatform();
	return directions.filter((direction) => {
		if (platform === "macos") return direction !== "NorthWest";
		return direction !== "NorthEast";
	});
}

async function startWindowResize(direction: ResizeDirection, enableFirst = false) {
	const win = getCurrentWindow();
	if (enableFirst) await win.setResizable(true);
	await win.setFocus();
	await win.startResizeDragging(direction);
}

function hasTouchLikePointer() {
	return (
		navigator.maxTouchPoints > 0 ||
		window.matchMedia("(any-pointer: coarse)").matches ||
		window.matchMedia("(hover: none)").matches
	);
}

function useHasTouchLikePointer() {
	const [hasTouchPointer, setHasTouchPointer] = useState(hasTouchLikePointer);

	useEffect(() => {
		const mediaQueries = [
			window.matchMedia("(any-pointer: coarse)"),
			window.matchMedia("(hover: none)"),
		];
		const update = () => setHasTouchPointer(hasTouchLikePointer());

		for (const query of mediaQueries) {
			query.addEventListener("change", update);
		}

		return () => {
			for (const query of mediaQueries) {
				query.removeEventListener("change", update);
			}
		};
	}, []);

	return hasTouchPointer;
}

function isInsideNoDragRegion(target: EventTarget | null) {
	return target instanceof Element && !!target.closest("[data-tauri-no-drag]");
}

function isInsideDragRegion(target: EventTarget | null) {
	return target instanceof Element && !!target.closest("[data-tauri-drag-region]");
}

function WindowResizeHandles() {
	const handlePointerDown =
		(direction: ResizeDirection) =>
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.pointerType !== "mouse") {
				event.preventDefault();
				event.stopPropagation();
				startWindowResize(direction, true).catch((err) =>
					console.error(`Failed to start touch ${direction} resize:`, err),
				);
				return;
			}
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			startWindowResize(direction).catch((err) =>
				console.error(`Failed to start ${direction} resize:`, err),
			);
		};

	return (
		<>
			{resizeDirectionsForPlatform(resizeDirections).map((direction) => (
				<button
					key={direction}
					className={`window-resize-handle window-resize-handle--${direction.toLowerCase()}`}
					onPointerDown={handlePointerDown(direction)}
					tabIndex={-1}
				/>
			))}
		</>
	);
}

function App() {
	const isTheaterMode = useUiStore((s) => s.isTheaterMode);
	const isMiniPlayerOpen = useUiStore((s) => s.isMiniPlayerOpen);
	const setMiniPlayerOpen = useUiStore((s) => s.setMiniPlayerOpen);
	const isQueueOpen = useUiStore((s) => s.isQueueOpen);
	const isSearchOpen = useUiStore((s) => s.isSearchOpen);
	const activeSection = useUiStore((s) => s.activeSection);
	const [browserTestRoute, setBrowserTestRoute] = useState(getInitialBrowserTestRoute);
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const theme = useThemeStore((s) => s.theme);
	const gpuAcceleration = useSettingsStore((s) => s.gpuAcceleration);
	const hasScheduledRuntimeIconRef = useRef(false);
	const touchLikePointer = useHasTouchLikePointer();
	const showWindowResizeHandles = !touchLikePointer || isLinux;

	useEffect(() => {
		// ponytail: touches that start on resize handles resize; all other touches disable OS edge resize.
		const touchPointers = new Set<number>();
		let unlockTimer: number | null = null;
		let previousResizable: boolean | null = null;
		const win = getCurrentWindow();
		const lock = async () => {
			if (unlockTimer !== null) {
				window.clearTimeout(unlockTimer);
				unlockTimer = null;
			}
			if (previousResizable === null) previousResizable = await win.isResizable();
			if (previousResizable) await win.setResizable(false);
		};
		const unlockSoon = () => {
			if (unlockTimer !== null) window.clearTimeout(unlockTimer);
			unlockTimer = window.setTimeout(async () => {
				if (previousResizable !== null) await win.setResizable(previousResizable);
				previousResizable = null;
				unlockTimer = null;
			}, 700);
		};
		const handlePointerDown = (event: PointerEvent) => {
			if (event.pointerType === "mouse") return;
			if (event.target instanceof Element && event.target.closest(".window-resize-handle")) return;
			touchPointers.add(event.pointerId);
			void lock().catch((err) => console.error("Failed to disable touch resize:", err));
		};
		const handlePointerEnd = (event: PointerEvent) => {
			if (event.pointerType === "mouse") return;
			touchPointers.delete(event.pointerId);
			if (touchPointers.size === 0) unlockSoon();
		};

		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("pointerup", handlePointerEnd, true);
		document.addEventListener("pointercancel", handlePointerEnd, true);
		return () => {
			if (unlockTimer !== null) window.clearTimeout(unlockTimer);
			if (previousResizable !== null) {
				void win.setResizable(previousResizable);
			}
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("pointerup", handlePointerEnd, true);
			document.removeEventListener("pointercancel", handlePointerEnd, true);
		};
	}, []);

	useEffect(() => {
		if (!__VIBY_BROWSER_TEST__) return;
		let cancelled = false;
		import("./browser-test/routes")
			.then(({ resolveBrowserTestRoute }) => {
				if (!cancelled) setBrowserTestRoute(resolveBrowserTestRoute(window.location));
			})
			.catch((err) => console.error("Failed to load browser test routes:", err));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		browserTestRoute?.setup?.();
	}, [browserTestRoute]);

	useEffect(() => {
		const handleTouchWindowDrag = (event: PointerEvent) => {
			if (event.pointerType === "mouse") return;
			if (!isInsideDragRegion(event.target) || isInsideNoDragRegion(event.target)) return;
			event.preventDefault();
			void getCurrentWindow().startDragging();
		};

		document.addEventListener("pointerdown", handleTouchWindowDrag);
		return () => document.removeEventListener("pointerdown", handleTouchWindowDrag);
	}, []);

	useEffect(() => {
		const prevent = (event: Event) => event.preventDefault();
		const preventWheelZoom = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
		};
		const preventKeyboardZoom = (event: KeyboardEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			if (!["+", "=", "-", "0"].includes(event.key)) return;
			event.preventDefault();
		};
		const preventPinchZoom = (event: TouchEvent) => {
			if (event.touches.length < 2) return;
			event.preventDefault();
		};

		const options = { passive: false, capture: true };
		window.addEventListener("keydown", preventKeyboardZoom);
		document.addEventListener("wheel", preventWheelZoom, options);
		document.addEventListener("touchstart", preventPinchZoom, options);
		document.addEventListener("touchmove", preventPinchZoom, options);
		document.addEventListener("gesturestart", prevent, options);
		document.addEventListener("gesturechange", prevent, options);
		document.addEventListener("gestureend", prevent, options);
		return () => {
			window.removeEventListener("keydown", preventKeyboardZoom);
			document.removeEventListener("wheel", preventWheelZoom, options);
			document.removeEventListener("touchstart", preventPinchZoom, options);
			document.removeEventListener("touchmove", preventPinchZoom, options);
			document.removeEventListener("gesturestart", prevent, options);
			document.removeEventListener("gesturechange", prevent, options);
			document.removeEventListener("gestureend", prevent, options);
		};
	}, []);

	// Apply saved theme on mount and whenever it changes
	useEffect(() => {
		applyTheme(theme);
		if ("__TAURI_INTERNALS__" in window) {
			const delay = hasScheduledRuntimeIconRef.current ? 200 : 1500;
			hasScheduledRuntimeIconRef.current = true;
			const timeoutId = window.setTimeout(() => {
				applyThemeRuntimeIcon(getThemeAccent(theme)).catch((err) =>
					console.error("Failed to update themed runtime icon:", err),
				);
			}, delay);
			return () => window.clearTimeout(timeoutId);
		}
		if (!("__TAURI_INTERNALS__" in window)) {
			document.documentElement.style.backgroundColor = "#0b0c0e";
		}
	}, [theme]);

	useEffect(() => {
		const win = getCurrentWindow();
		const clampWindow = async () => {
			try {
				await win.setMinSize(NORMAL_MIN_WINDOW_SIZE);
				const size = await win.innerSize();
				if (
					size.width < NORMAL_MIN_WINDOW_SIZE.width ||
					size.height < NORMAL_MIN_WINDOW_SIZE.height
				) {
					await win.setSize(NORMAL_MIN_WINDOW_SIZE);
				}
			} catch (e) {
				console.error("Failed to enforce minimum window size:", e);
			}
		};
		void clampWindow();
	}, []);

	// Toggle .no-gpu-compositing class on document root based on GPU settings
	useEffect(() => {
		document.documentElement.classList.toggle(
			"no-gpu-compositing",
			!gpuAcceleration,
		);
	}, [gpuAcceleration]);

	useEffect(() => {
		const syncVisibility = () => {
			invoke("set_frontend_visible", { visible: !document.hidden }).catch(
				(err) => console.error("Failed to sync frontend visibility:", err),
			);
		};
		const updateWindowActivity = () => {
			document.documentElement.classList.toggle(
				"app-window-inactive",
				!document.hasFocus(),
			);
		};

		window.addEventListener("focus", updateWindowActivity);
		window.addEventListener("blur", updateWindowActivity);
		document.addEventListener("visibilitychange", updateWindowActivity);
		document.addEventListener("visibilitychange", syncVisibility);
		updateWindowActivity();
		syncVisibility();

		return () => {
			window.removeEventListener("focus", updateWindowActivity);
			window.removeEventListener("blur", updateWindowActivity);
			document.removeEventListener("visibilitychange", updateWindowActivity);
			document.removeEventListener("visibilitychange", syncVisibility);
		};
	}, []);
	const setPlaybackSnapshot = usePlayerStore((s) => s.setPlaybackSnapshot);
	const setTracks = useLibraryStore((s) => s.setTracks);
	const setAlbums = useLibraryStore((s) => s.setAlbums);
	const setArtists = useLibraryStore((s) => s.setArtists);
	const setScanState = useLibraryStore((s) => s.setScanState);
	const setPlaylists = useLibraryStore((s) => s.setPlaylists);
	const setQueueState = useQueueStore((s) => s.setQueueState);
	const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
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
			await win.setMinSize(MINI_PLAYER_MIN_WINDOW_SIZE);
			await win.setResizable(false);
			await win.setSize(MINI_PLAYER_MIN_WINDOW_SIZE);
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
			await win.setMinSize(NORMAL_MIN_WINDOW_SIZE);
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
			await setRustVolume(state.volume, { immediate: true });
			await setRustShuffle(state.shuffle);
			await setRustRepeat(state.repeatMode);

			const eq = useSettingsStore.getState();
			await setBackgroundAppEnabled(eq.closeToTray).catch(
				(err) =>
					console.error("Failed to sync background app mode on startup:", err),
			);
			await invoke("set_discord_rpc_enabled", {
				enabled: eq.discordRpcEnabled,
			}).catch((err) =>
				console.error("Failed to sync Discord RPC setting on startup:", err),
			);
			await setSoundCheckEnabled(eq.soundCheckEnabled).catch((err) =>
				console.error("Failed to sync Sound Check setting on startup:", err),
			);
			await setSoundCheckTargetLufs(eq.soundCheckTargetLufs).catch((err) =>
				console.error("Failed to sync Sound Check target on startup:", err),
			);
			if (eq.soundCheckEnabled) {
				analyzeMissingNormalization().catch((err) =>
					console.error("Failed to start Sound Check analysis on startup:", err),
				);
			}
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

			const lastAutoScan = Number(localStorage.getItem(LAST_AUTO_SCAN_KEY));
			if (isAutoScanDue(lastAutoScan)) {
				invoke("scan_library")
					.then(() => localStorage.setItem(LAST_AUTO_SCAN_KEY, String(Date.now())))
					.catch((err) => console.error("Auto-scan failed:", err));
			}

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
							(progress.changed_tracks ?? 0) > 0 ||
							(progress.removed_tracks ?? 0) > 0;
						if (changed) loadLibraryData();
					}
				}),
				onQueueChanged((payload) => {
					if (cancelled) return;

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
	
						nextTrack(false).catch((e) =>
							console.error("Auto advance failed:", e),
						);
					}
				}),
			]);

			if (!cancelled) {
				unlistenFnsRef.current = fns;
				getCurrentWindow().show().catch((err) =>
					console.error("Failed to show window on startup:", err),
				);
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
					await setRustVolume(newVol, { immediate: true }).catch((err) =>
						console.error("Failed to change volume:", err),
					);
				} else if (e.key === "ArrowDown") {
					e.preventDefault();
					const currentVol = usePlayerStore.getState().volume;
					const newVol = Math.max(0, currentVol - 0.05);
					usePlayerStore.getState().setVolume(newVol);
					await setRustVolume(newVol, { immediate: true }).catch((err) =>
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

	const platform = getPlatform();
	const content = (
		<div
			className={`app-container platform-${platform} ${isTheaterMode ? "theater-mode" : ""} ${isMiniPlayerOpen ? "mini-player-mode" : ""}`}
		>
			{isMiniPlayerOpen && (
				<Suspense fallback={null}>
					<MiniPlayer onExpand={exitMiniPlayer} />
				</Suspense>
			)}

			{!isMiniPlayerOpen && !isTheaterMode && (
				<>
					<Titlebar />
					<div className="main-content">
						<Sidebar />
						<div className="content-wrapper">
							<div className="content-row">
								<main className="content-area">
									{activeSection === "playlist" ? (
										<Suspense fallback={null}>
											<PlaylistView />
										</Suspense>
									) : (
										<LibraryView />
									)}
								</main>
								{isQueueOpen && (
									<Suspense fallback={null}>
										<QueuePanel />
									</Suspense>
								)}
							</div>
							{currentTrack && <PlayerBar onMiniPlayer={enterMiniPlayer} />}
						</div>
					</div>
				</>
			)}

			{!isMiniPlayerOpen && isTheaterMode && (
				<Suspense fallback={null}>
					<FullscreenPlayer />
				</Suspense>
			)}
			{isSearchOpen && (
				<Suspense fallback={null}>
					<SearchModal />
				</Suspense>
			)}
			{browserTestRoute?.renderOverlay?.(() => setBrowserTestRoute(null))}
			<ToastContainer />
			{!isMiniPlayerOpen && showWindowResizeHandles && <WindowResizeHandles />}
		</div>
	);

	return content;
}

export default App;

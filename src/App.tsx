import { Suspense, lazy, useEffect, useRef, useState, useCallback } from "react";
import {
	getCurrentWindow,
	LogicalSize,
} from "@tauri-apps/api/window";

import { getPlatform } from "./utils/platform";
import { useUiStore } from "./stores/uiStore";
import { usePlayerStore } from "./stores/playerStore";
import { usePlaybackProgressStore } from "./stores/playbackProgressStore";
import { useSettingsStore } from "./stores/settingsStore";
import {
	useThemeStore,
	applyTheme,
	getThemeAccent,
	getThemeColorScheme,
} from "./stores/themeStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useQueueStore } from "./stores/queueStore";
import { usePlayerSync } from "./hooks/usePlayerSync";
import { useFrontendVisibility } from "./hooks/useFrontendVisibility";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { applyThemeRuntimeIcon } from "./utils/runtimeIcon";
import { isAutoScanDue } from "./utils/scanCadence";
import { presentScanProgress } from "./utils/scanOutcome";
import { restoreBackendState } from "./utils/initializeBackend";
import { isPlaybackDebugEnabled, logPlaybackDebug } from "./utils/debug";
import { formatInvokeError } from "./utils/errorMessage";
import { notifyActionFailure } from "./utils/actionFeedback";
import {
	onScanProgress,
	getAllTracks,
	getAlbums,
	getArtists,
	getPlaylists,
	refreshPlaybackMetadata,
	frontendReady,
	isGnomeDesktop,
	setNativeWindowTheme,
	setFrontendVisible as setFrontendVisibleBackend,
	setMainWebviewFocus,
	scanLibrary,
	showMiniPlayer,
	showTheaterMode,
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
const TrackDetailsPanel = lazy(() => import("./components/player/TrackDetailsPanel"));
const PlaylistView = lazy(() => import("./components/playlist/PlaylistView"));

function getResolvedThemeColors() {
	const probe = document.createElement("span");
	probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
	document.body.appendChild(probe);
	const resolve = (token: string) => {
		probe.style.color = `var(${token})`;
		return getComputedStyle(probe).color;
	};
	const colors = {
		background: resolve("--bg-secondary"),
		foreground: resolve("--text-primary"),
		hover: resolve("--bg-hover"),
		active: resolve("--bg-active"),
		accent: resolve("--accent"),
		border: resolve("--border"),
	};
	probe.remove();
	return colors;
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

async function startWindowResize(direction: ResizeDirection) {
	const win = getCurrentWindow();
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

function WindowResizeHandles() {
	const handlePointerDown =
		(direction: ResizeDirection) =>
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.pointerType !== "mouse" || event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			startWindowResize(direction).catch((err) =>
				{
					notifyActionFailure(err, `Couldn't resize the ${direction.toLowerCase()} window edge.`);
					console.error(`Failed to start ${direction} resize:`, err);
				},
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
	usePlayerSync();
	useGlobalShortcuts();
	const { frontendVisible, markFrontendVisible } = useFrontendVisibility();
	const isQueueOpen = useUiStore((s) => s.isQueueOpen);
	const isTrackDetailsOpen = useUiStore((s) => s.isTrackDetailsOpen);
	const setTrackDetailsOpen = useUiStore((s) => s.setTrackDetailsOpen);
	const isSearchOpen = useUiStore((s) => s.isSearchOpen);
	const activeSection = useUiStore((s) => s.activeSection);
	const [browserTestRoute, setBrowserTestRoute] = useState<BrowserTestRoute | null>(null);
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const theme = useThemeStore((s) => s.theme);
	const gpuAcceleration = useSettingsStore((s) => s.gpuAcceleration);
	const reduceVisualEffects = useSettingsStore((s) => s.reduceVisualEffects);
	const hasScheduledRuntimeIconRef = useRef(false);
	const touchLikePointer = useHasTouchLikePointer();
	const showWindowResizeHandles = !touchLikePointer && !isLinux;
	const [hasNativeLinuxDecorations, setHasNativeLinuxDecorations] = useState(isLinux);
	const [isTransitioningToMini, setIsTransitioningToMini] = useState(false);
	const [isTransitioningToTheater, setIsTransitioningToTheater] = useState(false);
	const isLibraryLoaded = useLibraryStore((s) => s.isLoaded);
	const isLibraryLoading = useLibraryStore((s) => s.isLoading);
	const libraryLoadError = useLibraryStore((s) => s.libraryLoadError);
	const isScanning = useLibraryStore((s) => s.isScanning);
	const scanProgress = useLibraryStore((s) => s.scanProgress);
	const scanStatusText = useLibraryStore((s) => s.scanStatusText);
	const scanError = useLibraryStore((s) => s.scanError);
	const scanNotice = useLibraryStore((s) => s.scanNotice);

	const handleEnterMiniPlayer = useCallback(() => {
		setIsTransitioningToMini(true);
		setTimeout(() => {
			void runActionWithFeedback(() => showMiniPlayer(), {
				failureMessage: "Couldn't open the mini player.",
			}).finally(() => setIsTransitioningToMini(false));
		}, 180);
	}, []);

	const handleEnterTheaterMode = useCallback(() => {
		setIsTransitioningToTheater(true);
		setTimeout(() => {
			void runActionWithFeedback(() => showTheaterMode(), {
				failureMessage: "Couldn't open theater mode.",
			}).finally(() => setIsTransitioningToTheater(false));
		}, 180);
	}, []);

	useEffect(() => {
		if (!isLinux) return;
		void isGnomeDesktop()
			.then(setHasNativeLinuxDecorations)
			.catch((err) => {
				setHasNativeLinuxDecorations(false);
				console.error("Failed to detect GNOME desktop:", err);
			});
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
		const handleUnhandledActionRejection = (event: PromiseRejectionEvent) => {
			console.error("Unhandled promise rejection:", event.reason);
			notifyActionFailure(event.reason, "An unexpected error occurred.");
		};

		window.addEventListener("unhandledrejection", handleUnhandledActionRejection);
		return () =>
			window.removeEventListener("unhandledrejection", handleUnhandledActionRejection);
	}, []);

	useEffect(() => {
		browserTestRoute?.setup?.();
	}, [browserTestRoute]);

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
			document.documentElement.style.backgroundColor = "var(--bg-primary)";
		}
	}, [theme]);

	useEffect(() => {
		if (!hasNativeLinuxDecorations) return;
		void setNativeWindowTheme({
			...getResolvedThemeColors(),
			dark: getThemeColorScheme(theme) === "dark",
		}).catch((err) => console.error("Failed to theme native GTK window:", err));
	}, [theme, hasNativeLinuxDecorations]);

	useEffect(() => {
		const win = getCurrentWindow();
		const clampWindow = async () => {
			try {
				await win.setMinSize(NORMAL_MIN_WINDOW_SIZE);
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
		document.documentElement.classList.toggle(
			"reduce-visual-effects",
			reduceVisualEffects,
		);
	}, [reduceVisualEffects]);

	const setLibraryData = useLibraryStore((s) => s.setLibraryData);
	const setLibraryLoading = useLibraryStore((s) => s.setLibraryLoading);
	const setLibraryLoadError = useLibraryStore((s) => s.setLibraryLoadError);
	const setScanState = useLibraryStore((s) => s.setScanState);
	const unlistenFnsRef = useRef<Array<() => void>>([]);
	const loadLibraryData = useCallback(async () => {
		setLibraryLoading();
		try {
			const [tracks, albums, artists, playlists] = await Promise.all([
				getAllTracks(),
				getAlbums(),
				getArtists(),
				getPlaylists(),
			]);
			setLibraryData({ tracks, albums, artists, playlists });
			void refreshPlaybackMetadata().catch((error) =>
				console.error("Failed to refresh playback metadata:", error),
			);
		} catch (error) {
			setLibraryLoadError(
				formatInvokeError(error, "Couldn't load your library."),
			);
			console.error("Failed to load library data:", error);
		}
	}, [setLibraryData, setLibraryLoadError, setLibraryLoading]);

	useEffect(() => {
		if (!isPlaybackDebugEnabled()) return;

		logPlaybackDebug("info", "UI hang watchdog enabled");

		let lastTick = performance.now();
		const interval = window.setInterval(() => {
			const now = performance.now();
			const stallMs = now - lastTick - 1000;
			if (stallMs > 1000) {
				const player = usePlayerStore.getState();
				const progress = usePlaybackProgressStore.getState();
				const queue = useQueueStore.getState();
				logPlaybackDebug("warn", "UI event loop stall", {
					stalled_ms: Math.round(stallMs),
					has_track: player.currentTrack !== null,
					position_secs: Number(progress.positionSecs.toFixed(2)),
					queue_len: queue.tracks.length,
					current_index: queue.currentIndex,
				});
			}
			lastTick = now;
		}, 1000);

		return () => window.clearInterval(interval);
	}, []);

	useEffect(() => {
		let cancelled = false;

		const setup = async () => {
			const unlisten = await onScanProgress((progress) => {
				if (cancelled) return;
				const presentation = presentScanProgress(progress);
				setScanState(
					presentation.isActive,
					presentation.percent,
					presentation.statusText,
					presentation.error,
					presentation.completionNotice,
				);
				if (presentation.shouldRefreshLibrary) {
					void loadLibraryData();
				}
			}).catch((error) => {
				console.error("Failed to register scan listener:", error);
				return undefined;
			});

			if (cancelled) {
				unlisten?.();
				return;
			}
			unlistenFnsRef.current = unlisten ? [unlisten] : [];

			await frontendReady().catch((err) =>
				console.error("Failed to show the main window after startup:", err),
			);
			if (cancelled) return;
			markFrontendVisible(true);
			void setFrontendVisibleBackend(true).catch((err) =>
				console.error("Failed to sync startup visibility:", err),
			);
			requestAnimationFrame(() => {
				if (cancelled) return;
				void getCurrentWindow()
					.setFocus()
					.then(() => setMainWebviewFocus())
					.then(() => window.focus())
					.catch((err) => console.error("Main window focus failed:", err));
			});

			await Promise.all([loadLibraryData(), restoreBackendState()]);

			const savedAutoScan = localStorage.getItem(LAST_AUTO_SCAN_KEY);
			if (savedAutoScan === null) {
				localStorage.setItem(LAST_AUTO_SCAN_KEY, String(Date.now()));
			} else if (isAutoScanDue(Number(savedAutoScan))) {
				void scanLibrary()
					.then(() => localStorage.setItem(LAST_AUTO_SCAN_KEY, String(Date.now())))
					.catch((err) => {
						notifyActionFailure(err, "Couldn't scan your library.");
						console.error("Auto-scan failed:", err);
					});
			}
		};

		void setup().catch((error) => {
			console.error("Application initialization failed:", error);
			notifyActionFailure(error, "Some player services failed to initialize.");
		});

		return () => {
			cancelled = true;
			unlistenFnsRef.current.forEach((fn) => fn());
			unlistenFnsRef.current = [];
		};
	}, [loadLibraryData, markFrontendVisible, setScanState]);

	if (!frontendVisible) return null;

	const platform = getPlatform();
	const content = (
		<div
			className={`app-container platform-${platform} ${hasNativeLinuxDecorations ? "native-window-decorations" : ""} ${isTransitioningToMini ? "is-transitioning-to-mini" : ""} ${isTransitioningToTheater ? "is-transitioning-to-theater" : ""}`}
		>
			{!hasNativeLinuxDecorations && <Titlebar />}
			<div className="main-content">
				<Sidebar />
				<div className="content-wrapper">
					<div className="content-row">
						<main className="content-area">
							{isLibraryLoading && isLibraryLoaded && (
								<div className="app-status-banner" role="status" aria-live="polite">
									<span className="app-status-message">Loading your library…</span>
								</div>
							)}
							{isScanning && (
								<div className="app-status-banner" role="status" aria-live="polite">
									<span className="app-status-spinner" aria-hidden="true" />
									<span className="app-status-message">{scanStatusText}</span>
									<progress
										className="app-scan-progress"
										max={100}
										value={scanProgress}
										aria-label="Library scan progress"
										aria-valuetext={scanStatusText}
									/>
								</div>
							)}
							{scanNotice && !isScanning && !scanError && (
								<div className="app-status-banner app-status-banner--notice" role="status" aria-live="polite">
									<span className="app-status-message">{scanNotice}</span>
									<button
										type="button"
										className="app-status-dismiss"
										onClick={() => setScanState(false, 0, "", null, null)}
									>
										Dismiss
									</button>
								</div>
							)}
							{scanError && (
								<div className="app-status-banner app-status-banner--error" role="alert">
									<span className="app-status-message">{scanError}</span>
									<button
										type="button"
										className="app-status-dismiss"
										onClick={() => setScanState(false, 0, "", null, null)}
									>
										Dismiss
									</button>
								</div>
							)}
							{libraryLoadError && (
								<div className="app-status-banner app-status-banner--error" role="alert">
									<span className="app-status-message">
										Couldn't load your library: {libraryLoadError}
									</span>
									<button
										type="button"
										className="app-status-dismiss"
									disabled={isLibraryLoading}
										onClick={() => void loadLibraryData()}
									>
										Retry
									</button>
								</div>
							)}
							{activeSection === "playlist" ? (
								<Suspense fallback={null}>
									<PlaylistView />
								</Suspense>
							) : (
								<LibraryView />
							)}
						</main>
						{isQueueOpen ? (
							<Suspense fallback={null}>
								<QueuePanel />
							</Suspense>
						) : isTrackDetailsOpen && currentTrack ? (
							<Suspense fallback={null}>
								<TrackDetailsPanel
									track={currentTrack}
									onClose={() => setTrackDetailsOpen(false)}
								/>
							</Suspense>
						) : null}
					</div>
					{currentTrack && (
						<PlayerBar
							onMiniPlayer={handleEnterMiniPlayer}
							onTheaterMode={handleEnterTheaterMode}
						/>
					)}
				</div>
			</div>

			{isSearchOpen && (
				<Suspense fallback={null}>
					<SearchModal />
				</Suspense>
			)}
			{browserTestRoute?.renderOverlay?.(() => setBrowserTestRoute(null))}
			<ToastContainer />
			{showWindowResizeHandles && <WindowResizeHandles />}
		</div>
	);

	return content;
}

export default App;

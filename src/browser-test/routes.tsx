import type { ReactNode } from "react";

import { useUiStore } from "../stores/uiStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { useSettingsStore } from "../stores/settingsStore";
import { emitBrowserTestEvent } from "../browser-shims/event";
import { scanLibrary, showMiniPlayer, showTheaterMode } from "../utils/tauri";
import SettingsModal, { type SettingsTab } from "../components/ui/SettingsModal";

export interface BrowserTestRoute {
	id: string;
	aliases?: string[];
	setup?: () => void;
	renderOverlay?: (close: () => void) => ReactNode;
}

function resetUi() {
	const ui = useUiStore.getState();
	ui.setSearchOpen(false);
	ui.setQueueOpen(false);
}

function libraryRoute(id: string, view: "songs" | "albums" | "artists"): BrowserTestRoute {
	return {
		id,
		aliases: [view],
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView(view);
		},
	};
}

function scanOutcomeRoute(
	id: "scan-partial" | "scan-fatal" | "scan-no-folders",
): BrowserTestRoute {
	return {
		id,
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			window.setTimeout(() => {
				void scanLibrary().catch(() => undefined);
			}, 1200);
		},
	};
}

function settingsRoute(
	id: string,
	tab: SettingsTab,
	aliases: string[] = [],
): BrowserTestRoute {
	return {
		id,
		aliases: [`settings:${tab}`, `settings-${tab}`, ...aliases],
		setup: resetUi,
		renderOverlay: (close) => (
			<SettingsModal isOpen onClose={close} initialTab={tab} />
		),
	};
}

export const BROWSER_TEST_ROUTES: BrowserTestRoute[] = [
	{
		id: "home",
		setup: () => {
			resetUi();
			useUiStore.getState().setActiveSection("home");
		},
	},
	{
		id: "scan-progress",
		aliases: ["scanning"],
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore
				.getState()
				.setScanState(true, 60, "Scanning 12 / 20 files");
		},
	},
	scanOutcomeRoute("scan-partial"),
	scanOutcomeRoute("scan-fatal"),
	scanOutcomeRoute("scan-no-folders"),
	{
		id: "library-loading",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore.setState({
				tracks: [],
				albums: [],
				artists: [],
				playlists: [],
				isLoaded: false,
				isLoading: true,
				libraryLoadError: null,
			});
		},
	},
	{
		id: "library-error",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore.setState({
				tracks: [],
				albums: [],
				artists: [],
				playlists: [],
				isLoaded: false,
				isLoading: false,
				libraryLoadError: "Demo database error",
			});
		},
	},
	{
		id: "toast-stack",
		setup: () => {
			useToastStore.setState({ toasts: [], currentAnnouncement: null, pendingAnnouncements: [] });
			const addToast = useToastStore.getState().addToast;
			addToast('Added "Into the Blue" to queue', "success", 0);
			addToast("Playback device is unavailable", "error", 0);
			addToast("Shuffle mode enabled", "info", 0);
			addToast("Could not update the queue. Try again.", "error", 0);
			addToast("Saved playback settings", "success", 0);
			addToast("Track removed from queue", "info", 0);
		},
	},
	libraryRoute("library:songs", "songs"),
	{
		id: "scan-refresh",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			window.setTimeout(() => {
				useLibraryStore
					.getState()
					.setScanState(true, 85, "Scanning 17 / 20 files");
				emitBrowserTestEvent("scan-progress", {
					total_files: 20,
					processed_files: 20,
					current_file: "",
					status: "complete",
					new_tracks: 1,
					changed_tracks: 0,
					removed_tracks: 0,
				});
			}, 1200);
		},
	},
	libraryRoute("library:albums", "albums"),
	libraryRoute("library:artists", "artists"),
	{
		id: "queue",
		setup: () => {
			resetUi();
			useUiStore.getState().setQueueOpen(true);
		},
	},
	{
		id: "search",
		setup: () => {
			resetUi();
			useUiStore.getState().setSearchOpen(true);
		},
	},
	{
		id: "theater",
		aliases: ["fullscreen", "fullscreen-player"],
		setup: () => {
			resetUi();
			void showTheaterMode();
		},
	},
	{
		id: "mini-player",
		aliases: ["mini"],
		setup: () => {
			resetUi();
			void showMiniPlayer();
		},
	},
	settingsRoute("settings:general", "general"),
	settingsRoute("settings:appearance", "appearance"),
	settingsRoute("settings:equalizer", "equalizer", ["equalizer", "eq"]),
	settingsRoute("settings:storage", "storage"),
	settingsRoute("settings:shortcuts", "shortcuts"),
	settingsRoute("settings:advanced", "advanced"),
	settingsRoute("settings:about", "about"),
	{
		id: "peq",
		aliases: ["parametric-eq", "settings:peq", "settings-peq"],
		setup: () => {
			resetUi();
			const settings = useSettingsStore.getState();
			settings.setEqEnabled(true);
			settings.setEqMode("parametric");
		},
		renderOverlay: (close) => (
			<SettingsModal
				isOpen
				onClose={close}
				initialTab="equalizer"
				initialPeqExpanded
			/>
		),
	},
];

export function resolveBrowserTestRoute(location: Location): BrowserTestRoute | null {
	const params = new URLSearchParams(location.search);
	const target =
		params.get("vibyTest") ??
		params.get("component") ??
		params.get("page") ??
		params.get("route") ??
		location.hash.replace(/^#\/?/, "");

	if (!target) return null;

	const normalized = target.trim().toLowerCase();
	return (
		BROWSER_TEST_ROUTES.find(
			(route) =>
				route.id === normalized || route.aliases?.includes(normalized),
		) ?? null
	);
}

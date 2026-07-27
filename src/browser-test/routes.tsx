import type { ReactNode } from "react";

import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { showMiniPlayer, showTheaterMode } from "../utils/tauri";
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
	libraryRoute("library:songs", "songs"),
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

import { useEffect } from "react";

import { isModalDialogOpen } from "../components/ui/dialogManager";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";
import { runActionWithFeedback } from "../utils/actionFeedback";
import { getSeekTarget, resolveGlobalShortcut } from "../utils/shortcuts";
import {
	exitApp,
	nextTrack,
	pausePlayback,
	previousTrack,
	resumePlayback,
	seekTo,
	setVolume as setRustVolume,
} from "../utils/tauri";

const GLOBAL_SHORTCUT_EXCLUDED_TARGETS = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	"summary",
	"[contenteditable]:not([contenteditable='false'])",
	"[role='button']",
	"[role='checkbox']",
	"[role='combobox']",
	"[role='gridcell']",
	"[role='link']",
	"[role='listbox']",
	"[role='menuitem']",
	"[role='option']",
	"[role='radio']",
	"[role='row']",
	"[role='slider']",
	"[role='switch']",
	"[role='tab']",
	"[role='textbox']",
	"[data-song-index]",
].join(",");

const MODAL_PASSTHROUGH_SHORTCUTS = new Set(["mod+q"]);

export function useGlobalShortcuts() {
	useEffect(() => {
		const handleGlobalKeys = (event: KeyboardEvent) => {
			const isMac = navigator.userAgent.toLowerCase().includes("mac");
			const isModKey = isMac ? event.metaKey : event.ctrlKey;
			const shortcut = `${isModKey ? "mod+" : ""}${event.key.toLowerCase()}`;
			if (
				event.defaultPrevented ||
				(isModalDialogOpen() && !MODAL_PASSTHROUGH_SHORTCUTS.has(shortcut))
			) return;

			const command = resolveGlobalShortcut(event, isMac);
			if (!command) return;

			const activeElement = document.activeElement;
			const isInteractiveTarget = [event.target, activeElement].some(
				(target) =>
					target instanceof Element &&
					target.closest(GLOBAL_SHORTCUT_EXCLUDED_TARGETS) !== null,
			);
			if (
				isInteractiveTarget &&
				command.type !== "toggleSearch" &&
				command.type !== "quit"
			) return;

			event.preventDefault();
			switch (command.type) {
				case "toggleSearch": {
					const { isSearchOpen, setSearchOpen } = useUiStore.getState();
					setSearchOpen(!isSearchOpen);
					break;
				}
				case "quit":
					void runActionWithFeedback(() => exitApp(), {
						failureMessage: "Couldn't close Viby.",
					});
					break;
				case "playPause": {
					const { isPlaying, currentTrack } = usePlayerStore.getState();
					if (currentTrack) {
						void runActionWithFeedback(
							() => isPlaying ? pausePlayback() : resumePlayback(),
							{ failureMessage: "Couldn't change playback state." },
						);
					}
					break;
				}
				case "nextTrack":
					void runActionWithFeedback(() => nextTrack(true), {
						failureMessage: "Couldn't go to the next track.",
					});
					break;
				case "previousOrRestart": {
					const { positionSecs } = usePlayerStore.getState();
					if (positionSecs > 3) {
						void runActionWithFeedback(() => seekTo(0), {
							failureMessage: "Couldn't seek to the start of the track.",
						});
					} else {
						void runActionWithFeedback(() => previousTrack(true), {
							failureMessage: "Couldn't go to the previous track.",
						});
					}
					break;
				}
				case "seek": {
					const { currentTrack, positionSecs, durationSecs } = usePlayerStore.getState();
					if (!currentTrack) break;
					const target = getSeekTarget(positionSecs, durationSecs, command.direction);
					void runActionWithFeedback(() => seekTo(target), {
						failureMessage: "Couldn't seek to that position.",
					});
					break;
				}
				case "volume": {
					const state = usePlayerStore.getState();
					const newVol = Math.max(0, Math.min(1, state.volume + command.direction * 0.05));
					state.setVolume(newVol);
					void runActionWithFeedback(() => setRustVolume(newVol, { immediate: true }), {
						failureMessage: "Couldn't change volume.",
					});
					break;
				}
			}
		};

		window.addEventListener("keydown", handleGlobalKeys);
		return () => window.removeEventListener("keydown", handleGlobalKeys);
	}, []);
}

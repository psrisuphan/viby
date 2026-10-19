import { useEffect } from "react";

import { usePlayerStore } from "../stores/playerStore";
import { usePlaybackProgressStore } from "../stores/playbackProgressStore";
import { useUiStore } from "../stores/uiStore";
import { isModalDialogOpen } from "../components/ui/dialogManager";
import { runActionWithFeedback } from "../utils/actionFeedback";
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

// While a modal is open, only these shortcuts stay active. Everything else is ignored so keys
// cannot reach background playback or navigation behind the dialog.
const MODAL_PASSTHROUGH_SHORTCUTS = new Set(["mod+q"]);

export function useGlobalShortcuts() {
	useEffect(() => {
		const handleGlobalKeys = (event: KeyboardEvent) => {
			const isMac = navigator.userAgent.toLowerCase().includes("mac");
			const isModKey = isMac ? event.metaKey : event.ctrlKey;
			const shortcut = `${isModKey ? "mod+" : ""}${event.key.toLowerCase()}`;
			// Let controls with their own keyboard behavior keep ownership of the event.
			if (
				event.defaultPrevented ||
				(isModalDialogOpen() && !MODAL_PASSTHROUGH_SHORTCUTS.has(shortcut))
			) return;
			const activeEl = document.activeElement;
			const isInput =
				activeEl && ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName);

			if (isModKey && event.key.toLowerCase() === "k") {
				event.preventDefault();
				const { isSearchOpen, setSearchOpen } = useUiStore.getState();
				setSearchOpen(!isSearchOpen);
				return;
			}

			if (isModKey && event.key.toLowerCase() === "q") {
				event.preventDefault();
				void runActionWithFeedback(() => exitApp(), {
					failureMessage: "Couldn't close Viby.",
				});
				return;
			}

			const isInteractiveTarget =
				(event.target instanceof Element &&
					event.target.closest(GLOBAL_SHORTCUT_EXCLUDED_TARGETS) !== null) ||
				(activeEl instanceof Element &&
					activeEl.closest(GLOBAL_SHORTCUT_EXCLUDED_TARGETS) !== null);
			if (isInput || isInteractiveTarget) return;

			if (event.key === " ") {
				event.preventDefault();
				const { isPlaying, currentTrack } = usePlayerStore.getState();
				if (currentTrack) {
					void runActionWithFeedback(
						() => isPlaying ? pausePlayback() : resumePlayback(),
						{ failureMessage: "Couldn't change playback state." },
					);
				}
			}

			if (!isModKey) return;
			if (event.key === "ArrowRight") {
				event.preventDefault();
				void runActionWithFeedback(() => nextTrack(true), {
					failureMessage: "Couldn't go to the next track.",
				});
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
				const { positionSecs } = usePlaybackProgressStore.getState();
				if (positionSecs > 3) {
					void runActionWithFeedback(() => seekTo(0), {
						failureMessage: "Couldn't seek to the start of the track.",
					});
				} else {
					void runActionWithFeedback(() => previousTrack(true), {
						failureMessage: "Couldn't go to the previous track.",
					});
				}
			} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				const currentVol = usePlayerStore.getState().volume;
				const newVol = Math.max(
					0,
					Math.min(1, currentVol + (event.key === "ArrowUp" ? 0.05 : -0.05)),
				);
				await setRustVolume(newVol, { immediate: true }).catch((err) =>
					console.error("Failed to change volume:", err),
				);
			}
		};

		window.addEventListener("keydown", handleGlobalKeys);
		return () => window.removeEventListener("keydown", handleGlobalKeys);
	}, []);
}

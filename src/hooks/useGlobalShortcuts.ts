import { useEffect } from "react";

import { usePlayerStore } from "../stores/playerStore";
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

const SPACE_SHORTCUT_EXCLUDED_TARGETS = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	"summary",
	"[contenteditable]:not([contenteditable='false'])",
	"[role='button']",
	"[role='checkbox']",
	"[role='link']",
	"[role='menuitem']",
	"[role='option']",
	"[role='radio']",
	"[role='row']",
	"[role='slider']",
	"[role='switch']",
	"[role='tab']",
].join(",");

function eventTargetMatches(event: KeyboardEvent, selector: string): boolean {
	return event.target instanceof Element && event.target.closest(selector) !== null;
}

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

			if (isInput) return;

			if (event.key === " ") {
				// Preserve native Space activation and local keyboard behavior on interactive controls.
				if (eventTargetMatches(event, SPACE_SHORTCUT_EXCLUDED_TARGETS)) return;
				event.preventDefault();
				const { isPlaying, currentTrack } = usePlayerStore.getState();
				if (currentTrack) {
					void runActionWithFeedback(
						() => isPlaying ? pausePlayback() : resumePlayback(),
						{ failureMessage: "Couldn't change playback state." },
					);
				}
			}

			// Modified arrows on sliders belong to the slider context, not playback shortcuts.
			if (!isModKey || eventTargetMatches(event, "[role='slider']")) return;
			if (event.key === "ArrowRight") {
				event.preventDefault();
				void runActionWithFeedback(() => nextTrack(true), {
					failureMessage: "Couldn't go to the next track.",
				});
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
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
			} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				const currentVol = usePlayerStore.getState().volume;
				const newVol = Math.max(
					0,
					Math.min(1, currentVol + (event.key === "ArrowUp" ? 0.05 : -0.05)),
				);
				usePlayerStore.getState().setVolume(newVol);
				void runActionWithFeedback(() => setRustVolume(newVol, { immediate: true }), {
					failureMessage: "Couldn't change volume.",
				});
			}
		};

		window.addEventListener("keydown", handleGlobalKeys);
		return () => window.removeEventListener("keydown", handleGlobalKeys);
	}, []);
}

import { useEffect } from "react";

import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";
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

export function useGlobalShortcuts() {
	useEffect(() => {
		const handleGlobalKeys = (event: KeyboardEvent) => {
			const activeEl = document.activeElement;
			const isInput =
				activeEl && ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName);

			const isMac = navigator.userAgent.toLowerCase().includes("mac");
			const isModKey = isMac ? event.metaKey : event.ctrlKey;

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

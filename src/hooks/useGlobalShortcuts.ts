import { useEffect } from "react";

import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";
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
		const handleGlobalKeys = async (event: KeyboardEvent) => {
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
				await exitApp().catch((err) => console.error("Failed to exit app:", err));
				return;
			}

			if (isInput) return;

			if (event.key === " ") {
				event.preventDefault();
				const { isPlaying, currentTrack } = usePlayerStore.getState();
				if (currentTrack) {
					if (isPlaying) {
						await pausePlayback().catch((err) => console.error("Failed to pause:", err));
					} else {
						await resumePlayback().catch((err) => console.error("Failed to resume:", err));
					}
				}
			}

			if (!isModKey) return;
			if (event.key === "ArrowRight") {
				event.preventDefault();
				await nextTrack(true).catch((err) => console.error("Failed to skip next:", err));
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
				const { positionSecs } = usePlayerStore.getState();
				if (positionSecs > 3) {
					await seekTo(0).catch((err) => console.error("Failed to seek:", err));
				} else {
					await previousTrack(true).catch((err) =>
						console.error("Failed to skip previous:", err),
					);
				}
			} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				const currentVol = usePlayerStore.getState().volume;
				const newVol = Math.max(
					0,
					Math.min(1, currentVol + (event.key === "ArrowUp" ? 0.05 : -0.05)),
				);
				usePlayerStore.getState().setVolume(newVol);
				await setRustVolume(newVol, { immediate: true }).catch((err) =>
					console.error("Failed to change volume:", err),
				);
			}
		};

		window.addEventListener("keydown", handleGlobalKeys);
		return () => window.removeEventListener("keydown", handleGlobalKeys);
	}, []);
}

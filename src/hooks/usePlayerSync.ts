import { useEffect, useRef } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
	getPlaybackState,
	getQueue,
	onPlaybackStateChange,
	onQueueChanged,
	onQueuePositionChanged,
} from "../utils/tauri";

function playbackDebugEnabled() {
	return (
		import.meta.env.DEV || localStorage.getItem("vibyDebugPlayback") === "1"
	);
}

export function usePlayerSync() {
	const setPlaybackSnapshot = usePlayerStore((s) => s.setPlaybackSnapshot);
	const setQueueState = useQueueStore((s) => s.setQueueState);
	const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
	const unlistenFnsRef = useRef<Array<() => void>>([]);

	useEffect(() => {
		const handleStorage = (e: StorageEvent) => {
			if (e.key === "viby-player-storage" || e.key === null) {
				void usePlayerStore.persist.rehydrate();
			}
			if (e.key === "viby-settings" || e.key === null) {
				void useSettingsStore.persist.rehydrate();
			}
		};
		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	useEffect(() => {
		let cancelled = false;

		const setup = async () => {
			const debugPlayback = playbackDebugEnabled();
			let playbackEventCount = 0;
			let lastPlaybackLog = performance.now();
			let lastPlaybackTrackId: string | null = null;

			let pendingPlaybackSnapshot:
				| Parameters<typeof setPlaybackSnapshot>[0]
				| null = null;
			let playbackRafId: number | null = null;

			const listenerResults = await Promise.allSettled([
				onPlaybackStateChange((s) => {
					if (cancelled) return;
					const currentTrackId = usePlayerStore.getState().currentTrack?.id;
					const newTrackId = s.current_track?.id;

					if (newTrackId && newTrackId !== currentTrackId) {
						if (playbackRafId !== null) {
							cancelAnimationFrame(playbackRafId);
							playbackRafId = null;
						}
						pendingPlaybackSnapshot = null;
						setPlaybackSnapshot(s);
						return;
					}

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
			]);

			const fns = listenerResults.flatMap((result) => {
				if (result.status === "fulfilled") return [result.value];
				console.error(
					"Failed to register player sync listener:",
					result.reason,
				);
				return [];
			});

			if (!cancelled) {
				unlistenFnsRef.current = fns;
				try {
					const [playback, queue] = await Promise.all([
						getPlaybackState(),
						getQueue(),
					]);
					if (!cancelled) {
						setPlaybackSnapshot(playback);
						setQueueState(queue);
					}
				} catch (err) {
					console.error("Failed to restore initial player sync state:", err);
				}
			} else {
				fns.forEach((fn) => fn());
			}
		};

		void setup();

		return () => {
			cancelled = true;
			unlistenFnsRef.current.forEach((fn) => fn());
			unlistenFnsRef.current = [];
		};
	}, [setPlaybackSnapshot, setQueueState, setCurrentIndex]);
}

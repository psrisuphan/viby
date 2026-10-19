import { useEffect, useRef } from "react";
import { usePlaybackProgressStore } from "../stores/playbackProgressStore";
import { usePlayerStore } from "../stores/playerStore";
import { useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";
import { isPlaybackDebugEnabled, logPlaybackDebug } from "../utils/debug";
import {
  PlaybackSyncOrder,
  QueueSnapshotOrder,
} from "../utils/playbackSyncOrder";
import {
  getPlaybackState,
  getQueue,
  onPlaybackProgressChange,
  onPlaybackStateChange,
  onQueueChanged,
  onQueuePositionChanged,
} from "../utils/tauri";

export function usePlayerSync() {
  const setPlaybackSnapshot = usePlayerStore((s) => s.setPlaybackSnapshot);
  const setProgress = usePlaybackProgressStore((s) => s.setProgress);
  const setQueueState = useQueueStore((s) => s.setQueueState);
  const setCurrentIndex = useQueueStore((s) => s.setCurrentIndex);
  const unlistenFnsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "viby-settings" || e.key === null) {
        void useSettingsStore.persist.rehydrate();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cancelPendingRaf: (() => void) | null = null;
    let removeResumeListeners: (() => void) | null = null;

    const setup = async () => {
      const snapshotOrder = new PlaybackSyncOrder();
      const queueSnapshotOrder = new QueueSnapshotOrder();
      const debugPlayback = isPlaybackDebugEnabled();
      let playbackEventCount = 0;
      let lastPlaybackLog = performance.now();
      let lastPlaybackTrackId: string | null = null;

      let playbackRafId: number | null = null;
      const schedulePlaybackSnapshot = () => {
        if (playbackRafId !== null) return;
        playbackRafId = requestAnimationFrame(() => {
          playbackRafId = null;
          const snapshot = snapshotOrder.takePendingSnapshot();
          if (snapshot && !cancelled) setPlaybackSnapshot(snapshot);
        });
      };
      cancelPendingRaf = () => {
        if (playbackRafId !== null) cancelAnimationFrame(playbackRafId);
        playbackRafId = null;
      };
      const applyInitialSnapshot = (
        playback: Parameters<typeof setPlaybackSnapshot>[0],
      ) => {
        const result = snapshotOrder.applyInitialSnapshot(playback);
        if (result.progressAccepted) {
          setProgress(
            playback.position_secs,
            playback.duration_secs,
            playback.progress_generation ?? 0,
            playback.progress_sequence ?? 0,
          );
        }
        if (result.controlsAccepted) {
          cancelPendingRaf?.();
          setPlaybackSnapshot(playback);
        }
      };
      const refreshBackendSnapshot = async () => {
        const queueRequest = queueSnapshotOrder.beginRequest();
        try {
          const [playback, queue] = await Promise.all([
            getPlaybackState(),
            getQueue(),
          ]);
          if (cancelled) return;
          applyInitialSnapshot(playback);
          if (queueSnapshotOrder.canApply(queueRequest)) {
            setQueueState(queue);
          }
        } catch (err) {
          console.error("Failed to restore initial player sync state:", err);
        }
      };

      const listenerResults = await Promise.allSettled([
        onPlaybackStateChange((s) => {
          if (cancelled) return;
          const accepted = snapshotOrder.queuePlaybackSnapshot(s);
          if (accepted.progressAccepted) {
            setProgress(
              s.position_secs,
              s.duration_secs,
              s.progress_generation ?? 0,
              s.progress_sequence ?? 0,
            );
          }
          if (accepted.controlsAccepted) schedulePlaybackSnapshot();
          const currentTrackId = usePlayerStore.getState().currentTrack?.id;
          const newTrackId = s.current_track?.id;

          if (debugPlayback) {
            playbackEventCount += 1;
            const now = performance.now();
            const trackId = s.current_track?.id ?? null;
            const trackChanged = trackId !== lastPlaybackTrackId;
            if (trackChanged || now - lastPlaybackLog >= 1000) {
              logPlaybackDebug("debug", "playback-state", {
                events_since_last_log: playbackEventCount,
                is_playing: s.is_playing,
                track_changed: trackChanged,
                position_secs: Number(s.position_secs.toFixed(2)),
              });
              playbackEventCount = 0;
              lastPlaybackLog = now;
              lastPlaybackTrackId = trackId;
            }
          }
          if (
            newTrackId &&
            newTrackId !== currentTrackId &&
            accepted.controlsAccepted
          ) {
            // Track changes are applied on the next frame, with the same ordering check.
            schedulePlaybackSnapshot();
          }
        }),
        onPlaybackProgressChange((progress) => {
          if (!cancelled && snapshotOrder.acceptProgress(progress)) {
            setProgress(
              progress.position_secs,
              progress.duration_secs,
              progress.generation,
              progress.sequence,
            );
          }
        }),
        onQueueChanged((payload) => {
          if (cancelled) return;
          queueSnapshotOrder.noteQueueUpdate();
          const started = performance.now();
          setQueueState(payload);
          if (debugPlayback) {
            logPlaybackDebug("debug", "queue-changed", {
              tracks: payload.tracks.length,
              current_index: payload.current_index,
              handler_ms: Number((performance.now() - started).toFixed(2)),
            });
          }
        }),
        onQueuePositionChanged((payload) => {
          if (cancelled) return;
          queueSnapshotOrder.noteQueueUpdate();
          const started = performance.now();
          setCurrentIndex(payload.current_index);
          if (debugPlayback) {
            logPlaybackDebug("debug", "queue-position-changed", {
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
        const refreshOnResume = () => {
          if (document.visibilityState === "visible")
            void refreshBackendSnapshot();
        };
        removeResumeListeners = () => {
          window.removeEventListener("focus", refreshOnResume);
          document.removeEventListener("visibilitychange", refreshOnResume);
        };
        window.addEventListener("focus", refreshOnResume);
        document.addEventListener("visibilitychange", refreshOnResume);
        await refreshBackendSnapshot();
      } else {
        fns.forEach((fn) => fn());
      }
    };

    void setup();

    return () => {
      cancelled = true;
      cancelPendingRaf?.();
      removeResumeListeners?.();
      unlistenFnsRef.current.forEach((fn) => fn());
      unlistenFnsRef.current = [];
    };
  }, [setPlaybackSnapshot, setProgress, setQueueState, setCurrentIndex]);
}

import { useRef, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Music, Disc3, Volume2, VolumeX, Pin, Shuffle, Repeat, ListMusic } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlaybackProgressStore } from '../../stores/playbackProgressStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useArtwork } from '../../utils/useArtwork';
import { getPlatform } from '../../utils/platform';
import { getPlaybackQualityInfo } from '../../utils/quality';
import { getModifierLabel } from '../../utils/shortcuts';
import { usePrefersReducedMotion } from '../../utils/usePrefersReducedMotion';
import { useWindowActive } from '../../utils/useWindowActive';
import { notifyActionFailure, runActionWithFeedback } from '../../utils/actionFeedback';
import { hideToBackground, pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo, setVolume as setRustVolume, toggleMutePlayback, toggleShufflePlayback, cycleRepeatPlayback } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import AccessibleSlider from '../ui/AccessibleSlider';
import QueuePanel from './QueuePanel';
import '../layout/PlayerBar.css';
import './MiniPlayer.css';

const BAR_COUNT = 46;
const VISUALIZER_FRAME_INTERVAL_MS = 1000 / 30;
const platform = getPlatform();
const backgroundCloseTitle =
  platform === 'macos'
    ? 'Hide to menu bar'
    : platform === 'windows'
      ? 'Hide to notification area'
      : 'Hide window and keep Viby running';

function AudioVisualizer({ progress, durationSecs, isPlaying, onSeek, onDragProgress, simple = false }: {
  progress: number;
  durationSecs: number;
  isPlaying: boolean;
  onSeek: (pct: number) => void;
  onDragProgress: (pct: number | null) => void;
  simple?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bars = useRef(Array.from({ length: BAR_COUNT }, () => 0.05));
  const targets = useRef(Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.5));
  const timerRef = useRef(0);
  const scheduleDrawRef = useRef<(() => void) | null>(null);
  const dragProgress = useRef<number | null>(null);
  const progressRef = useRef(progress);
  const isPlayingRef = useRef(isPlaying);

  const dimensionsRef = useRef({ width: 0, height: 0 });
  const accentColorRef = useRef('121, 236, 131');

  useEffect(() => {
    progressRef.current = progress;
    scheduleDrawRef.current?.();
  }, [progress]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    scheduleDrawRef.current?.();
  }, [isPlaying]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d')!;
    const initialRect = wrap.getBoundingClientRect();
    dimensionsRef.current = { width: initialRect.width, height: initialRect.height };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        dimensionsRef.current = { width, height };
      }
      scheduleDrawRef.current?.();
    });
    observer.observe(wrap);

    const updateAccentColor = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
      if (color) accentColorRef.current = color;
    };
    updateAccentColor();

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          updateAccentColor();
          scheduleDrawRef.current?.();
        }
      }
    });
    mutationObserver.observe(document.documentElement, { attributes: true });

    const draw = () => {
      timerRef.current = 0;
      const dpr = window.devicePixelRatio || 1;
      // Read from the WRAPPER div size cached in ref
      const { width: cssW, height: cssH } = dimensionsRef.current;

      if (cssW < 10 || cssH < 4) {
        return;
      }

      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        // Reset bar state so heights computed for the old size don't persist
        bars.current.fill(0.05);
        targets.current = Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.5);
      }
      ctx.clearRect(0, 0, W, H);

      const accentRgb = accentColorRef.current;

      const gap = Math.round(2 * dpr);
      const barW = Math.max(1, (W - gap * (BAR_COUNT - 1)) / BAR_COUNT);
      const displayProgress = dragProgress.current ?? progressRef.current;

      bars.current.forEach((h, i) => {
        if (isPlayingRef.current) {
          bars.current[i] += (targets.current[i] - h) * 0.12;
          if (Math.abs(bars.current[i] - targets.current[i]) < 0.02) {
            targets.current[i] = 0.1 + Math.random() * 0.9;
          }
        }

        const isPast = (i / BAR_COUNT) < displayProgress;
        const barH = Math.max(Math.round(3 * dpr), bars.current[i] * H * 0.85);
        const x = i * (barW + gap);
        const y = (H - barH) / 2;

        ctx.fillStyle = isPast
          ? `rgba(${accentRgb}, 0.95)`
          : 'hsla(0, 0%, 100%, 0.22)';

        ctx.beginPath();
        const r = Math.min(barW / 2, 2 * dpr);
        ctx.roundRect(x, y, barW, barH, r);
        ctx.fill();
      });

      if (isPlayingRef.current) scheduleDraw();
    };

    const scheduleDraw = () => {
      if (timerRef.current !== 0) return;
      timerRef.current = window.setTimeout(draw, VISUALIZER_FRAME_INTERVAL_MS);
    };
    scheduleDrawRef.current = scheduleDraw;
    draw();
    return () => {
      if (timerRef.current !== 0) window.clearTimeout(timerRef.current);
      scheduleDrawRef.current = null;
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  const handleProgressChange = (seconds: number) => {
    if (durationSecs <= 0) return;
    const pct = Math.max(0, Math.min(1, seconds / durationSecs));
    dragProgress.current = pct;
    onDragProgress(pct);
    scheduleDrawRef.current?.();
  };

  const handleProgressCommit = (seconds: number) => {
    if (durationSecs <= 0) return;
    onSeek(Math.max(0, Math.min(1, seconds / durationSecs)));
    setTimeout(() => {
      dragProgress.current = null;
      onDragProgress(null);
      scheduleDrawRef.current?.();
    }, 300);
  };

  const handleProgressCancel = () => {
    dragProgress.current = null;
    onDragProgress(null);
    scheduleDrawRef.current?.();
  };

  return (
    <AccessibleSlider
      ref={wrapRef}
      className="mini-vis-wrap"
      value={Math.max(0, Math.min(durationSecs, progress * durationSecs))}
      min={0}
      max={durationSecs}
      step={1}
      pageStep={30}
      ariaLabel="Playback position"
      ariaValueText={`${formatTime(progress * durationSecs)} of ${formatTime(durationSecs)}`}
      disabled={durationSecs <= 0}
      getHoverValueText={formatTime}
      onValueChange={handleProgressChange}
      onValueCommit={handleProgressCommit}
      onValueCancel={handleProgressCancel}
    >
      {simple ? (
        <div className="simple-playback-progress">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      ) : (
        <canvas ref={canvasRef} className="mini-visualizer" />
      )}
    </AccessibleSlider>
  );
}

function MiniProgressRow({ isPlaying, windowActive, prefersReducedMotion, reduceVisualEffects }: {
  isPlaying: boolean;
  windowActive: boolean;
  prefersReducedMotion: boolean;
  reduceVisualEffects: boolean;
}) {
  const positionSecs = usePlaybackProgressStore((s) => s.positionSecs);
  const durationSecs = usePlaybackProgressStore((s) => s.durationSecs);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const displaySecs = dragPct !== null ? dragPct * durationSecs : positionSecs;
  const remaining = Math.max(0, durationSecs - displaySecs);

  return (
    <div className="mini-progress-row" data-tauri-no-drag>
      <span className="mini-time">{formatTime(displaySecs)}</span>
      <AudioVisualizer
        progress={durationSecs > 0 ? (dragPct ?? positionSecs / durationSecs) : 0}
        isPlaying={isPlaying && windowActive && !prefersReducedMotion && !reduceVisualEffects}
        onSeek={(pct) => {
        void runActionWithFeedback(() => seekTo(pct * durationSecs), {
          failureMessage: 'Could not seek to that position.',
        });
      }}
        onDragProgress={setDragPct}
        simple={reduceVisualEffects}
      />
      <span className="mini-time">-{formatTime(remaining)}</span>
    </div>
  );
}

function MiniVolumeBar({ volume, onChange, visible, onDragChange }: {
  volume: number;
  onChange: (v: number, commit?: boolean) => void;
  visible: boolean;
  onDragChange: (dragging: boolean) => void;
}) {
  const dragVolumeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [dragVolume, setDragVolume] = useState<number | null>(null);

  const setVisualDragVolume = (nextVolume: number) => {
    dragVolumeRef.current = nextVolume;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setDragVolume(dragVolumeRef.current);
    });
  };

  const handleVolumeChange = (nextVolume: number) => {
    setVisualDragVolume(nextVolume);
    onChange(nextVolume);
  };

  const handleVolumeCommit = (finalVolume: number) => {
    onChange(finalVolume, true);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragVolumeRef.current = null;
    setDragVolume(null);
  };

  const handleVolumeCancel = (startingVolume: number) => {
    onChange(startingVolume, true);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragVolumeRef.current = null;
    setDragVolume(null);
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const displayVolume = dragVolume ?? volume;

  return (
    <AccessibleSlider
      className={`mini-vol-bar${visible ? ' mini-vol-bar--visible' : ''}`}
      value={displayVolume}
      min={0}
      max={1}
      step={0.01}
      pageStep={0.1}
      ariaLabel="Mini player volume"
      ariaValueText={`${Math.round(displayVolume * 100)} percent`}
      onValueChange={handleVolumeChange}
      onValueCommit={handleVolumeCommit}
      onValueCancel={handleVolumeCancel}
      onInteractionChange={onDragChange}
    >
      <div className="mini-vol-track">
        <div className="mini-vol-fill" style={{ width: `${displayVolume * 100}%` }} />
        <div className="mini-vol-thumb" style={{ left: `${displayVolume * 100}%` }} />
      </div>
      <div className={`volume-tooltip${visible ? ' visible' : ''}`}>
        {Math.round(displayVolume * 100)}%
      </div>
    </AccessibleSlider>
  );
}

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const modifierKey = getModifierLabel(navigator.userAgent);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const sampleRate = usePlayerStore((s) => s.sampleRate);
  const bitsPerSample = usePlayerStore((s) => s.bitsPerSample);
  const audioPath = usePlayerStore((s) => s.audioPath);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);
  const isQueueOpen = useUiStore((s) => s.isQueueOpen);
  const setQueueOpen = useUiStore((s) => s.setQueueOpen);
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const miniPlayerAlwaysOnTop = useSettingsStore(s => s.miniPlayerAlwaysOnTop);
  const reduceVisualEffects = useSettingsStore(s => s.reduceVisualEffects);
  const prefersReducedMotion = usePrefersReducedMotion();
  const windowActive = useWindowActive();
  const setMiniPlayerAlwaysOnTop = useSettingsStore(s => s.setMiniPlayerAlwaysOnTop);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey, { size: 768 });

  const [volVisible, setVolVisible] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const volumeFailureShownRef = useRef(false);
  const [artistScrollPx, setArtistScrollPx] = useState(0);
  const volHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artistLineRef = useRef<HTMLDivElement>(null);

  const artistLine = currentTrack
    ? `${currentTrack.artist}${currentTrack.album ? ` — ${currentTrack.album}` : ''}`
    : '—';

  // Apply persisted always-on-top preference on mount
  useEffect(() => {
    getCurrentWindow().setAlwaysOnTop(miniPlayerAlwaysOnTop);
  }, []);

  useLayoutEffect(() => {
    const line = artistLineRef.current;
    if (!line) return;
    const updateOverflow = () => {
      const next = Math.max(0, line.scrollWidth - line.clientWidth);
      setArtistScrollPx((current) => current === next ? current : next);
    };
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(line);
    return () => observer.disconnect();
  }, [artistLine]);

  const showVol = () => {
    if (volHideTimer.current) clearTimeout(volHideTimer.current);
    setVolVisible(true);
  };
  const hideVol = () => {
    if (volDragging) return;
    volHideTimer.current = setTimeout(() => setVolVisible(false), 300);
  };
  const persistVolume = (value: number, options?: { immediate?: boolean }) => {
    void setRustVolume(value, options).catch((error) => {
      if (volumeFailureShownRef.current) return;
      volumeFailureShownRef.current = true;
      notifyActionFailure(error, 'Could not change volume.');
      setTimeout(() => { volumeFailureShownRef.current = false; }, 1500);
    });
  };

  const handleClose = () => runActionWithFeedback(async () => {
    if (closeToTray) await hideToBackground();
    else await getCurrentWindow().close();
  }, { failureMessage: 'Could not close the mini player.' });

  const handleShuffle = () => runActionWithFeedback(
    () => toggleShufflePlayback(),
    { failureMessage: 'Could not change shuffle mode.' },
  );

  const handleRepeat = () => runActionWithFeedback(
    () => cycleRepeatPlayback(),
    { failureMessage: 'Could not change repeat mode.' },
  );

  return (
    <div className={`mini-player${isQueueOpen ? ' mini-player--queue-open' : ''}`} data-tauri-drag-region>
      {/* Backdrop: blurred artwork wash */}
      <div className="mini-backdrop">
        {artworkUrl && <img src={artworkUrl} alt="" className="mini-backdrop-img" draggable={false} />}
        <div className="mini-backdrop-overlay" />
      </div>

      {/* ── Top row: art + track info + window controls ── */}
      <div className="mini-top" data-tauri-drag-region>

        <div className="mini-art" data-tauri-drag-region>
          {artworkUrl
            ? <img src={artworkUrl} alt="" draggable={false} />
            : <div className="mini-art-placeholder"><Music size={28} /></div>}
        </div>

        <div className="mini-track" data-tauri-drag-region title={qualityInfo ? `${qualityInfo.badge}: ${qualityInfo.specs}` : undefined}>
          <div className="mini-title truncate">{currentTrack?.title ?? 'Nothing playing'}</div>
          <div
            ref={artistLineRef}
            className={`mini-artist${artistScrollPx > 0 ? ' is-overflowing' : ''}`}
            title={artistLine}
          >
            <span style={{ '--mini-artist-scroll': `-${artistScrollPx}px` } as CSSProperties}>
              {artistLine}
            </span>
          </div>
          {qualityInfo && (
            <div className="mini-quality">
              <span className={`quality-badge ${qualityInfo.isHiRes ? 'hi-res' : qualityInfo.isLossless ? 'lossless' : 'hq'}`}>
                {qualityInfo.badge}
              </span>
              <span className="quality-specs truncate">{qualityInfo.specs}</span>
            </div>
          )}
        </div>

        <div className="mini-wc" data-tauri-no-drag>
          <button
            className={`mini-wc-btn${miniPlayerAlwaysOnTop ? ' mini-wc-btn--pinned' : ''}`}
            onClick={() => {
              const next = !miniPlayerAlwaysOnTop;
              setMiniPlayerAlwaysOnTop(next);
              void runActionWithFeedback(() => getCurrentWindow().setAlwaysOnTop(next), {
                failureMessage: 'Could not update always-on-top.',
              });
            }}
            title={miniPlayerAlwaysOnTop ? 'Always on top (on)' : 'Always on top (off)'}
          >
            <Pin size={11} />
          </button>
          <button className="mini-wc-btn" onClick={onExpand} title="Expand">
            <Maximize2 size={11} />
          </button>
          <button className="mini-wc-btn mini-wc-btn--close" onClick={handleClose} title={closeToTray ? backgroundCloseTitle : 'Close'}>
            <X size={11} />
          </button>
        </div>
      </div>

      {/* ── Visualizer / progress row ── */}
      <MiniProgressRow
        isPlaying={isPlaying}
        windowActive={windowActive}
        prefersReducedMotion={prefersReducedMotion}
        reduceVisualEffects={reduceVisualEffects}
      />

      {/* ── Controls row ── */}
      <div className="mini-controls-row" data-tauri-no-drag>
        <div className="mini-controls-left">
          <div className="mini-vol-area" onMouseEnter={showVol} onMouseLeave={hideVol}>
            <button
              className="mini-icon-btn"
              onClick={() => {
                void runActionWithFeedback(() => toggleMutePlayback(), {
                  failureMessage: 'Could not change volume.',
                });
              }}
              onWheel={(e) => {
                e.preventDefault();
                const latestVolume = usePlayerStore.getState().volume;
                const newVol = Math.max(0, Math.min(1, latestVolume + (e.deltaY < 0 ? 0.05 : -0.05)));
                persistVolume(newVol, { immediate: true });
              }}
              title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            >
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <MiniVolumeBar
              volume={isMuted ? 0 : volume}
              onChange={(v, commit = false) => persistVolume(v, commit ? { immediate: true } : undefined)}
              visible={volVisible}
              onDragChange={(dragging) => {
                if (dragging) volumeFailureShownRef.current = false;
                setVolDragging(dragging);
                if (!dragging) hideVol();
              }}
            />
          </div>
        </div>

        <div className="mini-controls-center">
          <button
            className={`mini-icon-btn${shuffle ? ' active' : ''}`}
            onClick={handleShuffle}
            title="Shuffle"
          >
            <Shuffle size={17} />
          </button>
          <button className="mini-icon-btn" onClick={() => {
            void runActionWithFeedback(async () => {
              if (usePlaybackProgressStore.getState().positionSecs > 3) await seekTo(0);
              else await previousTrack(true);
            }, { failureMessage: 'Could not go to the previous track.' });
          }} title={`Restart / previous track (${modifierKey}+←)`}>
            <SkipBack size={19} fill="currentColor" />
          </button>
          <button
            className={`play-pause-btn ${isPlaying ? 'is-playing' : ''}`}
            onClick={() => {
              void runActionWithFeedback(
                () => isPlaying ? pausePlayback() : resumePlayback(),
                { failureMessage: 'Could not change playback state.' },
              );
            }}
            disabled={!currentTrack}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title="Play / Pause (Space)"
          >
            <Disc3 size={26} strokeWidth={1.5} className={`vinyl-icon ${isPlaying ? 'is-playing' : ''}`} />
          </button>
          <button className="mini-icon-btn" onClick={() => {
            void runActionWithFeedback(() => nextTrack(true), {
              failureMessage: 'Could not go to the next track.',
            });
          }} title={`Next track (${modifierKey}+→)`}>
            <SkipForward size={19} fill="currentColor" />
          </button>
          <button
            className={`mini-icon-btn${repeatMode !== 'off' ? ' active' : ''}`}
            onClick={handleRepeat}
            title={`Repeat: ${repeatMode}`}
          >
            <Repeat size={17} />
            {repeatMode === 'one' && <span className="repeat-one-badge">1</span>}
          </button>
        </div>

        <div className="mini-controls-right">
          <button
            type="button"
            className={`mini-queue-btn${isQueueOpen ? ' active' : ''}`}
            onClick={() => setQueueOpen(!isQueueOpen)}
            title="Play queue"
            aria-label="Play queue"
            aria-expanded={isQueueOpen}
          >
            <ListMusic size={17} />
          </button>
        </div>
      </div>

      {isQueueOpen && (
        <div className="mini-queue-area" data-tauri-no-drag>
          <QueuePanel compact />
        </div>
      )}

    </div>
  );
}

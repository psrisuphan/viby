import { useRef, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Music, Disc3, Volume2, VolumeX, Pin, Shuffle, Repeat, ListMusic } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useArtwork } from '../../utils/useArtwork';
import { getPlatform } from '../../utils/platform';
import { getPlaybackQualityInfo } from '../../utils/quality';
import { usePrefersReducedMotion } from '../../utils/usePrefersReducedMotion';
import { hideToBackground, pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo, setVolume as setRustVolume, setShuffle as setTauriShuffle, setRepeat as setTauriRepeat } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import type { RepeatMode } from '../../types';
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

function AudioVisualizer({ progress, isPlaying, onSeek, onDragProgress, simple = false }: {
  progress: number;
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

  const pctFromClientX = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pct = pctFromClientX(e.clientX);
    dragProgress.current = pct;
    onDragProgress(pct);
    scheduleDrawRef.current?.();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragProgress.current === null) return;
    e.preventDefault();
    const pct = pctFromClientX(e.clientX);
    dragProgress.current = pct;
    onDragProgress(pct);
    scheduleDrawRef.current?.();
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragProgress.current === null) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onSeek(pctFromClientX(e.clientX));
    setTimeout(() => {
      dragProgress.current = null;
      onDragProgress(null);
      scheduleDrawRef.current?.();
    }, 300);
  };

  return (
    <div
      ref={wrapRef}
      className="mini-vis-wrap"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      {simple ? (
        <div className="simple-playback-progress">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      ) : (
        <canvas ref={canvasRef} className="mini-visualizer" />
      )}
    </div>
  );
}

function MiniVolumeBar({ volume, onChange, visible, onDragChange }: {
  volume: number;
  onChange: (v: number, commit?: boolean) => void;
  visible: boolean;
  onDragChange: (dragging: boolean) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragVolumeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [dragVolume, setDragVolume] = useState<number | null>(null);

  const volumeFromClientX = (clientX: number) => {
    if (!barRef.current) return;
    const { left, width } = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - left) / width));
  };

  const setVisualDragVolume = (nextVolume: number) => {
    dragVolumeRef.current = nextVolume;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setDragVolume(dragVolumeRef.current);
    });
  };

  const seek = (clientX: number) => {
    const nextVolume = volumeFromClientX(clientX);
    if (nextVolume === undefined) return;
    setVisualDragVolume(nextVolume);
    onChange(nextVolume);
  };

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX);
    draggingRef.current = true;
    onDragChange(true);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    if (e.buttons !== 1 && e.pointerType === 'mouse') return;
    seek(e.clientX);
  };

  const handleEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const finalVolume = volumeFromClientX(e.clientX) ?? dragVolumeRef.current;
    if (finalVolume !== null) {
      onChange(finalVolume, true);
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dragVolumeRef.current = null;
    setDragVolume(null);
    draggingRef.current = false;
    onDragChange(false);
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
    <div
      className={`mini-vol-bar${visible ? ' mini-vol-bar--visible' : ''}`}
      ref={barRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
    >
      <div className="mini-vol-track">
        <div className="mini-vol-fill" style={{ width: `${displayVolume * 100}%` }} />
        <div className="mini-vol-thumb" style={{ left: `${displayVolume * 100}%` }} />
      </div>
      <div className={`volume-tooltip${visible ? ' visible' : ''}`}>
        {Math.round(displayVolume * 100)}%
      </div>
    </div>
  );
}

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const positionSecs = usePlayerStore((s) => s.positionSecs);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const previousVolume = usePlayerStore((s) => s.previousVolume);
  const sampleRate = usePlayerStore((s) => s.sampleRate);
  const bitsPerSample = usePlayerStore((s) => s.bitsPerSample);
  const audioPath = usePlayerStore((s) => s.audioPath);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);
  const isQueueOpen = useUiStore((s) => s.isQueueOpen);
  const setQueueOpen = useUiStore((s) => s.setQueueOpen);
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const miniPlayerAlwaysOnTop = useSettingsStore(s => s.miniPlayerAlwaysOnTop);
  const reduceVisualEffects = useSettingsStore(s => s.reduceVisualEffects);
  const prefersReducedMotion = usePrefersReducedMotion();
  const setMiniPlayerAlwaysOnTop = useSettingsStore(s => s.setMiniPlayerAlwaysOnTop);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey, { size: 768 });

  const [dragPct, setDragPct] = useState<number | null>(null);
  const [volVisible, setVolVisible] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
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
  const displaySecs = dragPct !== null ? dragPct * durationSecs : positionSecs;
  const remaining = Math.max(0, durationSecs - displaySecs);

  const handleClose = async () => {
    if (closeToTray) await hideToBackground();
    else await getCurrentWindow().close();
  };

  const handleShuffle = async () => {
    toggleShuffle();
    await setTauriShuffle(!shuffle);
  };

  const handleRepeat = async () => {
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    cycleRepeat();
    await setTauriRepeat(modes[(modes.indexOf(repeatMode) + 1) % modes.length]);
  };

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
            onClick={async () => {
              const next = !miniPlayerAlwaysOnTop;
              setMiniPlayerAlwaysOnTop(next);
              await getCurrentWindow().setAlwaysOnTop(next);
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
      <div className="mini-progress-row" data-tauri-no-drag>
        <span className="mini-time">{formatTime(displaySecs)}</span>
        <AudioVisualizer
          progress={durationSecs > 0 ? (dragPct ?? positionSecs / durationSecs) : 0}
          isPlaying={isPlaying && !prefersReducedMotion && !reduceVisualEffects}
          onSeek={(pct) => seekTo(pct * durationSecs)}
          onDragProgress={setDragPct}
          simple={reduceVisualEffects}
        />
        <span className="mini-time">-{formatTime(remaining)}</span>
      </div>

      {/* ── Controls row ── */}
      <div className="mini-controls-row" data-tauri-no-drag>
        <div className="mini-controls-left">
          <div className="mini-vol-area" onMouseEnter={showVol} onMouseLeave={hideVol}>
            <button
              className="mini-icon-btn"
              onClick={async () => { const v = isMuted ? (previousVolume || 1.0) : 0; toggleMute(); await setRustVolume(v, { immediate: true }); }}
              onWheel={async (e) => {
                e.preventDefault();
                const newVol = Math.max(0, Math.min(1, volume + (e.deltaY < 0 ? 0.05 : -0.05)));
                setVolume(newVol);
                await setRustVolume(newVol, { immediate: true });
              }}
              title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            >
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <MiniVolumeBar volume={isMuted ? 0 : volume} onChange={(v, commit = false) => { if (commit) setVolume(v); void setRustVolume(v, commit ? { immediate: true } : undefined); }} visible={volVisible} onDragChange={(d) => { setVolDragging(d); if (!d) hideVol(); }} />
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
          <button className="mini-icon-btn" onClick={async () => {
            if (positionSecs > 3) await seekTo(0);
            else await previousTrack(true);
          }} title="Previous">
            <SkipBack size={19} fill="currentColor" />
          </button>
          <button
            className={`play-pause-btn ${isPlaying ? 'is-playing' : ''}`}
            onClick={() => isPlaying ? pausePlayback() : resumePlayback()}
            disabled={!currentTrack}
          >
            <Disc3 size={26} strokeWidth={1.5} className={`vinyl-icon ${isPlaying ? 'is-playing' : ''}`} />
          </button>
          <button className="mini-icon-btn" onClick={() => nextTrack(true)} title="Next">
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

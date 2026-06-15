import { useRef, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Music, Disc3, Volume2, VolumeX, Pin } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useArtwork } from '../../utils/useArtwork';
import { getPlatform } from '../../utils/platform';
import { getPlaybackQualityInfo } from '../../utils/quality';
import { hideToBackground, pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo, setVolume as setRustVolume } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import '../layout/PlayerBar.css';
import './MiniPlayer.css';

const BAR_COUNT = 46;
const isLinux = getPlatform() === 'linux';
const platform = getPlatform();
const backgroundCloseTitle =
  platform === 'macos'
    ? 'Hide to menu bar'
    : platform === 'windows'
      ? 'Hide to notification area'
      : 'Hide window and keep Viby running';

function AudioVisualizer({ progress, isPlaying, onSeek, onDragProgress }: {
  progress: number;
  isPlaying: boolean;
  onSeek: (pct: number) => void;
  onDragProgress: (pct: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bars = useRef(Array.from({ length: BAR_COUNT }, () => 0.05));
  const targets = useRef(Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.5));
  const rafRef = useRef(0);
  const dragProgress = useRef<number | null>(null);
  const progressRef = useRef(progress);
  const isPlayingRef = useRef(isPlaying);

  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d')!;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      // Read from the WRAPPER div — its size is purely CSS-driven and never
      // affected by the canvas pixel buffer size, breaking any feedback loop.
      const { width: cssW, height: cssH } = wrap.getBoundingClientRect();

      if (cssW < 10 || cssH < 4) {
        rafRef.current = requestAnimationFrame(draw);
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

      const accentRgb = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-rgb').trim() || '121, 236, 131';

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

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const pctFromClientX = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isLinux && e.pointerType !== 'mouse') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pct = pctFromClientX(e.clientX);
    dragProgress.current = pct;
    onDragProgress(pct);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragProgress.current === null) return;
    if (isLinux && e.pointerType !== 'mouse') return;
    e.preventDefault();
    const pct = pctFromClientX(e.clientX);
    dragProgress.current = pct;
    onDragProgress(pct);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragProgress.current === null) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onSeek(pctFromClientX(e.clientX));
    setTimeout(() => { dragProgress.current = null; onDragProgress(null); }, 300);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    e.preventDefault();
    const pct = pctFromClientX(e.touches[0].clientX);
    dragProgress.current = pct;
    onDragProgress(pct);

    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length === 0) return;
      ev.preventDefault();
      const nextPct = pctFromClientX(ev.touches[0].clientX);
      dragProgress.current = nextPct;
      onDragProgress(nextPct);
    };

    const onTouchEnd = (ev: TouchEvent) => {
      const endTouch = ev.changedTouches[0] || ev.touches[0];
      if (endTouch) onSeek(pctFromClientX(endTouch.clientX));
      setTimeout(() => { dragProgress.current = null; onDragProgress(null); }, 300);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  return (
    <div
      ref={wrapRef}
      className="mini-vis-wrap"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onTouchStart={handleTouchStart}
    >
      <canvas ref={canvasRef} className="mini-visualizer" />
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
    if (isLinux && e.pointerType !== 'mouse') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX);
    draggingRef.current = true;
    onDragChange(true);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    if (isLinux && e.pointerType !== 'mouse') return;
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

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    e.preventDefault();
    seek(e.touches[0].clientX);
    draggingRef.current = true;
    onDragChange(true);

    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length === 0) return;
      ev.preventDefault();
      seek(ev.touches[0].clientX);
    };

    const onTouchEnd = (ev: TouchEvent) => {
      const endTouch = ev.changedTouches[0] || ev.touches[0];
      const finalVolume = endTouch
        ? volumeFromClientX(endTouch.clientX) ?? dragVolumeRef.current
        : dragVolumeRef.current;
      if (finalVolume !== null) onChange(finalVolume, true);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      dragVolumeRef.current = null;
      setDragVolume(null);
      draggingRef.current = false;
      onDragChange(false);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
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
      onTouchStart={handleTouchStart}
    >
      <div className="mini-vol-track">
        <div className="mini-vol-fill" style={{ width: `${displayVolume * 100}%` }} />
        <div className="mini-vol-thumb" style={{ left: `${displayVolume * 100}%` }} />
      </div>
    </div>
  );
}

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const { isPlaying, currentTrack, positionSecs, durationSecs, volume, isMuted, previousVolume, sampleRate, bitsPerSample, audioPath, toggleMute, setVolume } = usePlayerStore();
  const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const miniPlayerAlwaysOnTop = useSettingsStore(s => s.miniPlayerAlwaysOnTop);
  const setMiniPlayerAlwaysOnTop = useSettingsStore(s => s.setMiniPlayerAlwaysOnTop);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey);

  const [dragPct, setDragPct] = useState<number | null>(null);
  const [volVisible, setVolVisible] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const [exiting, setExiting] = useState(false);
  const volHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply persisted always-on-top preference on mount
  useEffect(() => {
    getCurrentWindow().setAlwaysOnTop(miniPlayerAlwaysOnTop);
  }, []);

  // Play exit animation then fire the real callback
  const animateOut = (cb: () => void) => {
    setExiting(true);
    setTimeout(cb, 160);
  };

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

  const handleClose = () => animateOut(async () => {
    if (closeToTray) await hideToBackground();
    else await getCurrentWindow().close();
  });

  return (
    <div className={`mini-player${exiting ? ' mini-player--out' : ''}`} data-tauri-drag-region>
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
          <div className="mini-artist truncate">
            {currentTrack ? `${currentTrack.artist}${currentTrack.album ? ` — ${currentTrack.album}` : ''}` : '—'}
          </div>
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
          <button className="mini-wc-btn" onClick={() => animateOut(onExpand)} title="Expand">
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
          progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
          isPlaying={isPlaying}
          onSeek={(pct) => seekTo(pct * durationSecs)}
          onDragProgress={setDragPct}
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
        </div>

        <div className="mini-controls-right" />
      </div>

    </div>
  );
}

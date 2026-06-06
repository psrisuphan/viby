import { useRef, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Music, Disc3, Volume2, VolumeX } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useArtwork } from '../../utils/useArtwork';
import { pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo, setVolume as setRustVolume } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import '../layout/PlayerBar.css';
import './MiniPlayer.css';

const BAR_COUNT = 46;

function AudioVisualizer({ progress, isPlaying, onSeek, onDragProgress }: {
  progress: number;
  isPlaying: boolean;
  onSeek: (pct: number) => void;
  onDragProgress: (pct: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bars = useRef(Array.from({ length: BAR_COUNT }, () => 0.15 + Math.random() * 0.5));
  const targets = useRef(Array.from({ length: BAR_COUNT }, () => 0.15 + Math.random() * 0.85));
  const rafRef = useRef(0);
  const dragProgress = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;

    const draw = () => {
      const W = canvas.clientWidth * dpr;
      const H = canvas.clientHeight * dpr;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.clearRect(0, 0, W, H);

      const gap = 2 * dpr;
      const barW = (W - gap * (BAR_COUNT - 1)) / BAR_COUNT;
      const displayProgress = dragProgress.current ?? progress;

      bars.current.forEach((h, i) => {
        if (isPlaying) {
          bars.current[i] += (targets.current[i] - h) * 0.12;
          if (Math.abs(bars.current[i] - targets.current[i]) < 0.02) {
            targets.current[i] = 0.1 + Math.random() * 0.9;
          }
        }

        const isPast = (i / BAR_COUNT) < displayProgress;
        const barH = Math.max(3 * dpr, bars.current[i] * H * 0.85);
        const x = i * (barW + gap);
        const y = (H - barH) / 2;

        ctx.fillStyle = isPast
          ? 'hsla(142, 65%, 55%, 0.95)'
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
  }, [isPlaying, progress]);

  const pctFromEvent = (e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const pct = pctFromEvent(e);
    dragProgress.current = pct;
    onDragProgress(pct);
    const onMove = (ev: MouseEvent) => {
      const p = pctFromEvent(ev);
      dragProgress.current = p;
      onDragProgress(p);
    };
    const onUp = (ev: MouseEvent) => {
      onSeek(pctFromEvent(ev));
      setTimeout(() => { dragProgress.current = null; onDragProgress(null); }, 300);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <canvas
      ref={canvasRef}
      className="mini-visualizer"
      onMouseDown={handleMouseDown}
    />
  );
}

function MiniVolumeBar({ volume, onChange, visible, onDragChange }: {
  volume: number;
  onChange: (v: number) => void;
  visible: boolean;
  onDragChange: (dragging: boolean) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  const seek = (clientX: number) => {
    if (!barRef.current) return;
    const { left, width } = barRef.current.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, (clientX - left) / width)));
  };

  const handleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    seek(e.clientX);
    onDragChange(true);
    const onMove = (ev: MouseEvent) => seek(ev.clientX);
    const onUp = () => {
      onDragChange(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className={`mini-vol-bar${visible ? ' mini-vol-bar--visible' : ''}`} ref={barRef} onMouseDown={handleDown}>
      <div className="mini-vol-track">
        <div className="mini-vol-fill" style={{ width: `${volume * 100}%` }} />
        <div className="mini-vol-thumb" style={{ left: `${volume * 100}%` }} />
      </div>
    </div>
  );
}

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const { isPlaying, currentTrack, positionSecs, durationSecs, volume, isMuted, previousVolume, toggleMute, setVolume } = usePlayerStore();
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey);

  const [dragPct, setDragPct] = useState<number | null>(null);
  const [volHovered, setVolHovered] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const volVisible = volHovered || volDragging;
  const displaySecs = dragPct !== null ? dragPct * durationSecs : positionSecs;
  const remaining = Math.max(0, durationSecs - displaySecs);

  const handleClose = async () => {
    if (closeToTray) await getCurrentWindow().hide();
    else await getCurrentWindow().close();
  };

  return (
    <div className="mini-player" data-tauri-drag-region>
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

        <div className="mini-track" data-tauri-drag-region>
          <div className="mini-title truncate">{currentTrack?.title ?? 'Nothing playing'}</div>
          <div className="mini-artist truncate">
            {currentTrack ? `${currentTrack.artist}${currentTrack.album ? ` — ${currentTrack.album}` : ''}` : '—'}
          </div>
        </div>

        <div className="mini-wc" data-tauri-no-drag>
          <button className="mini-wc-btn" onClick={onExpand} title="Expand">
            <Maximize2 size={11} />
          </button>
          <button className="mini-wc-btn mini-wc-btn--close" onClick={handleClose} title={closeToTray ? 'Hide to tray' : 'Close'}>
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
        <div className="mini-controls-left" onMouseEnter={() => setVolHovered(true)} onMouseLeave={() => setVolHovered(false)}>
          <button
            className="mini-icon-btn"
            onClick={async () => { const v = isMuted ? (previousVolume || 1.0) : 0; toggleMute(); await setRustVolume(v); }}
            onWheel={async (e) => {
              e.preventDefault();
              const newVol = Math.max(0, Math.min(1, volume + (e.deltaY < 0 ? 0.05 : -0.05)));
              setVolume(newVol);
              await setRustVolume(newVol);
            }}
            title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
          >
            {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <MiniVolumeBar volume={isMuted ? 0 : volume} onChange={async (v) => { setVolume(v); await setRustVolume(v); }} visible={volVisible} onDragChange={setVolDragging} />
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


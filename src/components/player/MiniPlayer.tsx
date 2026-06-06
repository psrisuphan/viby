import { useRef, useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Music, Minus, Disc3, Volume2, VolumeX } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useArtwork } from '../../utils/useArtwork';
import { pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo, setVolume as setRustVolume } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import '../layout/PlayerBar.css';
import './MiniPlayer.css';

function MiniVolumeBar({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  const barRef = useRef<HTMLDivElement>(null);

  const handleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    seek(e.clientX);
    const onMove = (ev: MouseEvent) => seek(ev.clientX);
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const seek = (clientX: number) => {
    if (!barRef.current) return;
    const { left, width } = barRef.current.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, (clientX - left) / width)));
  };

  return (
    <div className="mini-vol-bar" ref={barRef} onMouseDown={handleDown}>
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

  const progressRef = useRef<HTMLDivElement>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPct, setSeekPct] = useState(0);

  const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
  const displayPct = isSeeking ? seekPct : progress;
  const remaining = Math.max(0, durationSecs - positionSecs);

  const handleSeekDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const bar = progressRef.current;
    if (!bar) return;
    const { left, width } = bar.getBoundingClientRect();
    setSeekPct(Math.max(0, Math.min(1, (e.clientX - left) / width)) * 100);
    setIsSeeking(true);
  };

  const handleSeekMove = useCallback((e: MouseEvent) => {
    if (!isSeeking || !progressRef.current) return;
    const { left, width } = progressRef.current.getBoundingClientRect();
    setSeekPct(Math.max(0, Math.min(1, (e.clientX - left) / width)) * 100);
  }, [isSeeking]);

  const handleSeekUp = useCallback((e: MouseEvent) => {
    if (!isSeeking || !progressRef.current) return;
    const { left, width } = progressRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - left) / width));
    seekTo(pct * durationSecs);
    setIsSeeking(false);
  }, [isSeeking, durationSecs]);

  useEffect(() => {
    if (!isSeeking) return;
    window.addEventListener('mousemove', handleSeekMove);
    window.addEventListener('mouseup', handleSeekUp);
    return () => {
      window.removeEventListener('mousemove', handleSeekMove);
      window.removeEventListener('mouseup', handleSeekUp);
    };
  }, [isSeeking, handleSeekMove, handleSeekUp]);

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
          <button className="mini-wc-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
            <Minus size={11} />
          </button>
          <button className="mini-wc-btn" onClick={onExpand} title="Expand">
            <Maximize2 size={11} />
          </button>
          <button className="mini-wc-btn mini-wc-btn--close" onClick={handleClose} title={closeToTray ? 'Hide to tray' : 'Close'}>
            <X size={11} />
          </button>
        </div>
      </div>

      {/* ── Progress row ── */}
      <div className="mini-progress-row" data-tauri-no-drag>
        <span className="mini-time">{formatTime(positionSecs)}</span>
        <div className="mini-seek" ref={progressRef} onMouseDown={handleSeekDown}>
          <div className="mini-seek-track">
            <div className="mini-seek-fill" style={{ width: `${displayPct}%` }} />
            <div className="mini-seek-thumb" style={{ left: `${displayPct}%` }} />
          </div>
        </div>
        <span className="mini-time">-{formatTime(remaining)}</span>
      </div>

      {/* ── Controls row ── */}
      <div className="mini-controls-row" data-tauri-no-drag>
        <div className="mini-controls-left">
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
          <MiniVolumeBar volume={isMuted ? 0 : volume} onChange={async (v) => { setVolume(v); await setRustVolume(v); }} />
        </div>

        <div className="mini-controls-center">
          <button className="mini-icon-btn" onClick={() => previousTrack(true)} title="Previous">
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


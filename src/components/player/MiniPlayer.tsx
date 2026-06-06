import { useRef, useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Play, Pause, Music, Minus } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useArtwork } from '../../utils/useArtwork';
import { pausePlayback, resumePlayback, nextTrack, previousTrack, seekTo } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import './MiniPlayer.css';

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const { isPlaying, currentTrack, positionSecs, durationSecs } = usePlayerStore();
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey);

  const progressRef = useRef<HTMLDivElement>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPct, setSeekPct] = useState(0);

  const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
  const displayPct = isSeeking ? seekPct : progress;

  const getPct = (e: React.MouseEvent) => {
    const bar = progressRef.current;
    if (!bar) return 0;
    const { left, width } = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - left) / width));
  };

  const handleSeekDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsSeeking(true);
    setSeekPct(getPct(e) * 100);
  };

  const handleSeekMove = useCallback((e: MouseEvent) => {
    if (!isSeeking) return;
    const bar = progressRef.current;
    if (!bar) return;
    const { left, width } = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - left) / width));
    setSeekPct(pct * 100);
  }, [isSeeking]);

  const handleSeekUp = useCallback((e: MouseEvent) => {
    if (!isSeeking) return;
    const bar = progressRef.current;
    if (!bar) return;
    const { left, width } = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - left) / width));
    seekTo(pct * durationSecs);
    setIsSeeking(false);
  }, [isSeeking, durationSecs]);

  useEffect(() => {
    if (isSeeking) {
      window.addEventListener('mousemove', handleSeekMove);
      window.addEventListener('mouseup', handleSeekUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleSeekMove);
      window.removeEventListener('mouseup', handleSeekUp);
    };
  }, [isSeeking, handleSeekMove, handleSeekUp]);

  const handleClose = async () => {
    if (closeToTray) {
      await getCurrentWindow().hide();
    } else {
      await getCurrentWindow().close();
    }
  };

  const handleMinimize = () => getCurrentWindow().minimize();

  return (
    <div className="mini-player glass-panel-heavy" data-tauri-drag-region>

      {/* Window controls — top right */}
      <div className="mini-wc" data-tauri-no-drag>
        <button className="mini-wc-btn" onClick={handleMinimize} title="Minimize"><Minus size={11} /></button>
        <button className="mini-wc-btn" onClick={onExpand} title="Expand to full player"><Maximize2 size={11} /></button>
        <button className="mini-wc-btn mini-wc-btn--close" onClick={handleClose} title={closeToTray ? 'Hide to tray' : 'Close'}><X size={11} /></button>
      </div>

      {/* Main body */}
      <div className="mini-body">
        {/* Artwork */}
        <div className="mini-art">
          {artworkUrl
            ? <img src={artworkUrl} alt="" draggable={false} />
            : <div className="mini-art-placeholder"><Music size={28} /></div>}
        </div>

        {/* Right side */}
        <div className="mini-right" data-tauri-drag-region>
          {/* Track info */}
          <div className="mini-info" data-tauri-drag-region>
            <div className="mini-title truncate">{currentTrack?.title ?? 'Nothing playing'}</div>
            <div className="mini-artist truncate">{currentTrack?.artist ?? '—'}</div>
          </div>

          {/* Progress bar */}
          <div className="mini-seek-row" data-tauri-no-drag>
            <span className="mini-time">{formatTime(positionSecs)}</span>
            <div
              className="mini-seek"
              ref={progressRef}
              onMouseDown={handleSeekDown}
            >
              <div className="mini-seek-track">
                <div className="mini-seek-fill" style={{ width: `${displayPct}%` }} />
                <div className="mini-seek-thumb" style={{ left: `${displayPct}%` }} />
              </div>
            </div>
            <span className="mini-time mini-time--remaining">
              -{formatTime(Math.max(0, durationSecs - positionSecs))}
            </span>
          </div>

          {/* Controls */}
          <div className="mini-controls" data-tauri-no-drag>
            <button className="mini-ctrl-btn" onClick={() => previousTrack(true)} title="Previous">
              <SkipBack size={16} fill="currentColor" />
            </button>
            <button className="mini-ctrl-btn mini-ctrl-btn--play" onClick={() => isPlaying ? pausePlayback() : resumePlayback()}>
              {isPlaying
                ? <Pause size={18} fill="currentColor" />
                : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
            </button>
            <button className="mini-ctrl-btn" onClick={() => nextTrack(true)} title="Next">
              <SkipForward size={16} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

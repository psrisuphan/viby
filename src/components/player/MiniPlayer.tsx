import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, X, SkipBack, SkipForward, Play, Pause, Music } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useArtwork } from '../../utils/useArtwork';
import { pausePlayback, resumePlayback, nextTrack, previousTrack } from '../../utils/tauri';
import './MiniPlayer.css';

interface Props {
  onExpand: () => void;
}

export default function MiniPlayer({ onExpand }: Props) {
  const { isPlaying, currentTrack, positionSecs, durationSecs } = usePlayerStore();
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const albumKey = currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined;
  const { artworkUrl } = useArtwork(currentTrack?.id ?? null, albumKey);

  const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;

  const handleClose = async () => {
    if (closeToTray) {
      await getCurrentWindow().hide();
    } else {
      await getCurrentWindow().close();
    }
  };

  const handlePlayPause = () => {
    if (isPlaying) pausePlayback(); else resumePlayback();
  };

  return (
    <div className="mini-player glass-panel-heavy" data-tauri-drag-region>
      <div className="mini-player-body">
        {/* Artwork */}
        <div className="mini-player-art">
          {artworkUrl
            ? <img src={artworkUrl} alt="" />
            : <Music size={18} className="text-tertiary" />}
        </div>

        {/* Track info */}
        <div className="mini-player-info" data-tauri-drag-region>
          <div className="mini-player-title truncate">
            {currentTrack?.title ?? 'Nothing playing'}
          </div>
          <div className="mini-player-artist truncate">
            {currentTrack?.artist ?? '—'}
          </div>
        </div>

        {/* Controls */}
        <div className="mini-player-controls" data-tauri-no-drag>
          <button className="mini-btn" onClick={() => previousTrack(true)} title="Previous">
            <SkipBack size={14} />
          </button>
          <button className="mini-btn mini-btn--play" onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>
          <button className="mini-btn" onClick={() => nextTrack(true)} title="Next">
            <SkipForward size={14} />
          </button>
        </div>

        {/* Window buttons */}
        <div className="mini-player-window-btns" data-tauri-no-drag>
          <button className="mini-win-btn" onClick={onExpand} title="Expand">
            <Maximize2 size={12} />
          </button>
          <button className="mini-win-btn mini-win-btn--close" onClick={handleClose} title={closeToTray ? 'Hide to tray' : 'Close'}>
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mini-player-progress">
        <div className="mini-player-progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

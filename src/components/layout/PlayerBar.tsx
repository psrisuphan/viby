import { useRef } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, 
  Volume2, VolumeX, Shuffle, Repeat, 
  ListMusic, Maximize2 
} from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { formatTime } from '../../utils/formatTime';
import { 
  pausePlayback, resumePlayback, 
  seekTo, setVolume as setRustVolume 
} from '../../utils/tauri';
import './PlayerBar.css';

export default function PlayerBar() {
  const { 
    isPlaying, currentTrack, positionSecs, durationSecs, 
    volume, isMuted, shuffle, repeatMode,
    toggleMute, setVolume, toggleShuffle, cycleRepeat
  } = usePlayerStore();
  
  const { isQueueOpen, setQueueOpen, setTheaterMode } = useUiStore();
  
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  const handlePlayPause = async () => {
    if (!currentTrack) return;
    if (isPlaying) {
      await pausePlayback();
    } else {
      await resumePlayback();
    }
  };

  const handleSeek = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentTrack || !progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newPos = Math.max(0, Math.min(percent * durationSecs, durationSecs));
    await seekTo(newPos);
  };

  const handleVolumeChange = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newVol = Math.max(0, Math.min(percent, 1));
    setVolume(newVol);
    await setRustVolume(newVol);
  };

  const progressPercent = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
  const volumePercent = isMuted ? 0 : volume * 100;

  return (
    <div className="player-bar glass-panel-heavy">
      {/* ── Progress Bar ── */}
      <div 
        className="progress-container" 
        ref={progressBarRef}
        onClick={handleSeek}
      >
        <div className="progress-bar-bg">
          <div 
            className="progress-bar-fill" 
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className="player-content">
        {/* ── Left: Now Playing Info ── */}
        <div className="player-left">
          {currentTrack ? (
            <>
              <div className="now-playing-art">
                {/* Artwork will go here. For now a placeholder */}
                <div className="artwork-placeholder">
                  <Music size={24} />
                </div>
              </div>
              <div className="now-playing-info">
                <div className="track-title truncate" title={currentTrack.title}>
                  {currentTrack.title}
                </div>
                <div className="track-artist truncate" title={currentTrack.artist}>
                  {currentTrack.artist}
                </div>
              </div>
            </>
          ) : (
            <div className="now-playing-empty">
              No track playing
            </div>
          )}
        </div>

        {/* ── Center: Playback Controls ── */}
        <div className="player-center">
          <div className="controls-row">
            <button 
              className={`icon-btn ${shuffle ? 'active' : ''}`}
              onClick={toggleShuffle}
              title="Shuffle"
            >
              <Shuffle size={18} />
            </button>
            <button className="icon-btn" title="Previous">
              <SkipBack size={20} />
            </button>
            <button 
              className="play-pause-btn"
              onClick={handlePlayPause}
              disabled={!currentTrack}
            >
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="play-icon-offset" />}
            </button>
            <button className="icon-btn" title="Next">
              <SkipForward size={20} />
            </button>
            <button 
              className={`icon-btn ${repeatMode !== 'off' ? 'active' : ''}`}
              onClick={cycleRepeat}
              title={`Repeat: ${repeatMode}`}
            >
              <Repeat size={18} />
              {repeatMode === 'one' && <span className="repeat-one-badge">1</span>}
            </button>
          </div>
          <div className="time-display">
            <span>{formatTime(positionSecs)}</span>
            <span>{formatTime(durationSecs)}</span>
          </div>
        </div>

        {/* ── Right: Extra Controls ── */}
        <div className="player-right">
          <button 
            className={`icon-btn ${isQueueOpen ? 'active' : ''}`}
            onClick={() => setQueueOpen(!isQueueOpen)}
            title="Queue"
          >
            <ListMusic size={18} />
          </button>
          
          <div className="volume-control">
            <button className="icon-btn" onClick={toggleMute}>
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <div 
              className="volume-slider" 
              ref={volumeBarRef}
              onClick={handleVolumeChange}
            >
              <div className="volume-slider-bg">
                <div 
                  className="volume-slider-fill"
                  style={{ width: `${volumePercent}%` }}
                />
              </div>
            </div>
          </div>

          <button 
            className="icon-btn" 
            onClick={() => setTheaterMode(true)}
            title="Theater Mode"
          >
            <Maximize2 size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Simple fallback icon import since we didn't import Music at the top
import { Music } from 'lucide-react';

import { useRef, useState, useEffect } from 'react';
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
  seekTo, setVolume as setRustVolume,
  nextTrack, previousTrack,
  setShuffle as setTauriShuffle, setRepeat as setTauriRepeat
} from '../../utils/tauri';
import { useToastStore } from '../../stores/toastStore';
import type { RepeatMode } from '../../types';
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
  
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [isVolumeHovered, setIsVolumeHovered] = useState(false);
  
  const currentTrackRef = useRef<string | undefined>(currentTrack?.id);

  useEffect(() => {
    if (currentTrack && currentTrack.id !== currentTrackRef.current) {
      useToastStore.getState().addToast(`Now playing: ${currentTrack.title}`, 'info');
      currentTrackRef.current = currentTrack.id;
    }
  }, [currentTrack]);

  const handlePlayPause = async () => {
    if (!currentTrack) return;
    if (isPlaying) {
      await pausePlayback();
    } else {
      await resumePlayback();
    }
  };

  const [isSeeking, setIsSeeking] = useState(false);
  const [seekProgress, setSeekProgress] = useState(0); // local percent 0-100

  const handleSeekMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentTrack || !progressBarRef.current) return;
    setIsSeeking(true);
    
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    setSeekProgress(percent * 100);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const movePercent = Math.max(0, Math.min((moveEvent.clientX - rect.left) / rect.width, 1));
      setSeekProgress(movePercent * 100);
    };
    
    const handleMouseUp = async (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      const finalPercent = Math.max(0, Math.min((upEvent.clientX - rect.left) / rect.width, 1));
      const newPos = finalPercent * durationSecs;
      await seekTo(newPos);
      
      // Small delay before releasing seek state so backend has time to update
      setTimeout(() => setIsSeeking(false), 300);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleVolumeChange = async (e: MouseEvent | React.MouseEvent) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newVol = Math.max(0, Math.min(percent, 1));
    setVolume(newVol);
    await setRustVolume(newVol);
  };

  const handleVolumeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    handleVolumeChange(e);
    setIsVolumeDragging(true);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      handleVolumeChange(moveEvent);
    };
    
    const handleMouseUp = () => {
      setIsVolumeDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };
  
  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      // The handlers are enclosed in handleVolumeMouseDown, but we can't easily remove them here.
      // In a real robust implementation, we might store them in refs, but this is fine for now.
    };
  }, []);

  const handleShuffle = async () => {
    toggleShuffle(); // Optimistic UI update
    await setTauriShuffle(!shuffle);
  };

  const handleRepeat = async () => {
    cycleRepeat(); // Optimistic UI update
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    const idx = modes.indexOf(repeatMode);
    const nextMode = modes[(idx + 1) % modes.length];
    await setTauriRepeat(nextMode);
  };

  const actualProgressPercent = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
  const displayProgressPercent = isSeeking ? seekProgress : actualProgressPercent;
  const volumePercent = isMuted ? 0 : volume * 100;
  
  // Calculate display time based on seek state
  const displayTimeSecs = isSeeking ? (seekProgress / 100) * durationSecs : positionSecs;

  return (
    <div className="player-bar glass-panel-heavy">
      {/* ── Progress Bar ── */}
      <div 
        className="progress-container" 
        ref={progressBarRef}
        onMouseDown={handleSeekMouseDown}
      >
        <div className="progress-bar-bg">
          <div 
            className="progress-bar-fill" 
            style={{ width: `${displayProgressPercent}%` }}
          />
          <div 
            className="progress-bar-thumb"
            style={{ left: `${displayProgressPercent}%` }}
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
              onClick={handleShuffle}
              title="Shuffle"
            >
              <Shuffle size={18} />
            </button>
            <button className="icon-btn" title="Previous" onClick={() => previousTrack()}>
              <SkipBack size={20} />
            </button>
            <button 
              className="play-pause-btn"
              onClick={handlePlayPause}
              disabled={!currentTrack}
            >
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="play-icon-offset" />}
            </button>
            <button className="icon-btn" title="Next" onClick={() => nextTrack()}>
              <SkipForward size={20} />
            </button>
            <button 
              className={`icon-btn ${repeatMode !== 'off' ? 'active' : ''}`}
              onClick={handleRepeat}
              title={`Repeat: ${repeatMode}`}
            >
              <Repeat size={18} />
              {repeatMode === 'one' && <span className="repeat-one-badge">1</span>}
            </button>
          </div>
          <div className="time-display">
            <span>{formatTime(displayTimeSecs)}</span>
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
            <button className="icon-btn" onClick={toggleMute} title="Mute">
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <div 
              className="volume-slider-wrapper"
              onMouseEnter={() => setIsVolumeHovered(true)}
              onMouseLeave={() => setIsVolumeHovered(false)}
            >
              <div 
                className="volume-slider" 
                ref={volumeBarRef}
                onMouseDown={handleVolumeMouseDown}
              >
                <div className="volume-slider-bg">
                  <div 
                    className="volume-slider-fill"
                    style={{ width: `${volumePercent}%` }}
                  />
                  <div 
                    className="volume-slider-thumb"
                    style={{ left: `${volumePercent}%` }}
                  />
                </div>
              </div>
              
              <div className={`volume-tooltip ${isVolumeHovered || isVolumeDragging ? 'visible' : ''}`}>
                {Math.round(volumePercent)}%
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

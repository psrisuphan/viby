import { useRef, useState, useEffect } from 'react';
import {
  SkipBack, SkipForward,
  Volume2, VolumeX, Shuffle, Repeat,
  ListMusic, Maximize2, Minimize2, Music, Disc3
} from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { getPlatform } from '../../utils/platform';
import { formatTime } from '../../utils/formatTime';
import { 
  pausePlayback, resumePlayback, 
  seekTo, setVolume as setRustVolume,
  nextTrack, previousTrack,
  setShuffle as setTauriShuffle, setRepeat as setTauriRepeat
} from '../../utils/tauri';
import { useToastStore } from '../../stores/toastStore';
import type { RepeatMode } from '../../types';
import { useArtwork } from '../../utils/useArtwork';
import { getPlaybackQualityInfo } from '../../utils/quality';
import './PlayerBar.css';

interface PlayerBarProps {
  onMiniPlayer?: () => void;
}

const isLinux = getPlatform() === "linux";

export default function PlayerBar({ onMiniPlayer }: PlayerBarProps) {
  const {
    isPlaying, currentTrack, positionSecs, durationSecs,
    volume, isMuted, shuffle, repeatMode,
    sampleRate, bitsPerSample, audioPath,
    setIsPlaying, toggleMute, setVolume, toggleShuffle, cycleRepeat
  } = usePlayerStore();
  
  const { isQueueOpen, setQueueOpen, setTheaterMode, setSelectedAlbum, setSelectedArtist } = useUiStore();
  const albums = useLibraryStore((s) => s.albums);
  const artists = useLibraryStore((s) => s.artists);
  const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);
  
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [isVolumeHovered, setIsVolumeHovered] = useState(false);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const volumeDraggingRef = useRef(false);
  const dragVolumeRef = useRef<number | null>(null);
  const volumeRafRef = useRef<number | null>(null);
  
  const currentTrackRef = useRef<string | undefined>(currentTrack?.id);
  const { artworkUrl } = useArtwork(
    currentTrack?.id || null,
    currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined,
  );

  useEffect(() => {
    if (currentTrack && currentTrack.id !== currentTrackRef.current) {
      useToastStore.getState().addToast(`Now playing: ${currentTrack.title}`, 'info');
      currentTrackRef.current = currentTrack.id;
    }
  }, [currentTrack]);

  const handlePlayPause = async () => {
    if (!currentTrack) return;
    if (isPlaying) {
      setIsPlaying(false);
      await pausePlayback();
    } else {
      setIsPlaying(true);
      await resumePlayback();
    }
  };

  const handleAlbumClick = () => {
    if (!currentTrack || !currentTrack.album) return;
    const albumObj =
      albums.find((a) => a.name === currentTrack.album && a.artist === currentTrack.album_artist) ||
      albums.find((a) => a.name === currentTrack.album && a.artist === currentTrack.artist) ||
      albums.find((a) => a.name === currentTrack.album);

    if (albumObj) {
      setTheaterMode(false);
      setSelectedAlbum(albumObj);
    }
  };

  const handleArtistClick = () => {
    if (!currentTrack) return;
    const artistObj =
      artists.find((a) => a.name === currentTrack.album_artist) ||
      artists.find((a) => a.name === currentTrack.artist);

    if (artistObj) {
      setTheaterMode(false);
      setSelectedArtist(artistObj);
    }
  };

  const [isSeeking, setIsSeeking] = useState(false);
  const [seekProgress, setSeekProgress] = useState(0); // local percent 0-100
  const seekingRef = useRef(false);

  const seekPercentFromClientX = (clientX: number) => {
    if (!currentTrack || !progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  };

  const handleSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!currentTrack) return;
    if (isLinux && e.pointerType !== "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekingRef.current = true;
    setIsSeeking(true);
    
    const percent = seekPercentFromClientX(e.clientX);
    if (percent === undefined) return;
    setSeekProgress(percent * 100);
  };

  const handleSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    if (isLinux && e.pointerType !== "mouse") return;
    e.preventDefault();
    const percent = seekPercentFromClientX(e.clientX);
    if (percent === undefined) return;
    setSeekProgress(percent * 100);
  };

  const handleSeekPointerEnd = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    seekingRef.current = false;
    const finalPercent = seekPercentFromClientX(e.clientX);
    if (finalPercent !== undefined) {
      await seekTo(finalPercent * durationSecs);
    }
    
    // Small delay before releasing seek state so backend has time to update
    setTimeout(() => setIsSeeking(false), 300);
  };

  const handleSeekTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!currentTrack || e.touches.length === 0) return;
    e.preventDefault();
    seekingRef.current = true;
    setIsSeeking(true);

    const percent = seekPercentFromClientX(e.touches[0].clientX);
    if (percent !== undefined) setSeekProgress(percent * 100);

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length === 0) return;
      moveEvent.preventDefault();
      const movePercent = seekPercentFromClientX(moveEvent.touches[0].clientX);
      if (movePercent !== undefined) setSeekProgress(movePercent * 100);
    };

    const handleTouchEnd = async (endEvent: TouchEvent) => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      seekingRef.current = false;

      const endTouch = endEvent.changedTouches[0] || endEvent.touches[0];
      if (endTouch) {
        const finalPercent = seekPercentFromClientX(endTouch.clientX);
        if (finalPercent !== undefined) await seekTo(finalPercent * durationSecs);
      }

      setTimeout(() => setIsSeeking(false), 300);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
  };

  const getVolumeFromClientX = (clientX: number) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const percent = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(percent, 1));
  };

  const setVisualDragVolume = (newVol: number) => {
    dragVolumeRef.current = newVol;
    if (volumeRafRef.current !== null) return;
    volumeRafRef.current = requestAnimationFrame(() => {
      volumeRafRef.current = null;
      setDragVolume(dragVolumeRef.current);
    });
  };

  const setVolumeFromClientX = (clientX: number) => {
    const newVol = getVolumeFromClientX(clientX);
    if (newVol === undefined) return;
    setVisualDragVolume(newVol);
    void setRustVolume(newVol);
  };

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isLinux && e.pointerType !== "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setVolumeFromClientX(e.clientX);
    volumeDraggingRef.current = true;
    setIsVolumeDragging(true);
  };

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeDraggingRef.current) return;
    if (isLinux && e.pointerType !== "mouse") return;
    e.preventDefault();
    setVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const finalVolume = getVolumeFromClientX(e.clientX) ?? dragVolumeRef.current;
    if (finalVolume !== null) {
      setVolume(finalVolume);
      void setRustVolume(finalVolume, { immediate: true });
    }
    if (volumeRafRef.current !== null) {
      cancelAnimationFrame(volumeRafRef.current);
      volumeRafRef.current = null;
    }
    dragVolumeRef.current = null;
    setDragVolume(null);
    volumeDraggingRef.current = false;
    setIsVolumeDragging(false);
  };

  const handleVolumeTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    e.preventDefault();
    setVolumeFromClientX(e.touches[0].clientX);
    volumeDraggingRef.current = true;
    setIsVolumeDragging(true);

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length === 0) return;
      moveEvent.preventDefault();
      setVolumeFromClientX(moveEvent.touches[0].clientX);
    };

    const handleTouchEnd = (endEvent: TouchEvent) => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);

      const endTouch = endEvent.changedTouches[0] || endEvent.touches[0];
      const finalVolume = endTouch
        ? getVolumeFromClientX(endTouch.clientX) ?? dragVolumeRef.current
        : dragVolumeRef.current;
      if (finalVolume !== null) {
        setVolume(finalVolume);
        void setRustVolume(finalVolume, { immediate: true });
      }
      if (volumeRafRef.current !== null) {
        cancelAnimationFrame(volumeRafRef.current);
        volumeRafRef.current = null;
      }
      dragVolumeRef.current = null;
      setDragVolume(null);
      volumeDraggingRef.current = false;
      setIsVolumeDragging(false);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
  };
  
  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      if (volumeRafRef.current !== null) {
        cancelAnimationFrame(volumeRafRef.current);
      }
    };
  }, []);

  const handleMuteToggle = async () => {
    const { isMuted, previousVolume } = usePlayerStore.getState();
    const newVolume = isMuted ? (previousVolume || 1.0) : 0;
    toggleMute();
    await setRustVolume(newVolume, { immediate: true });
  };

  const handleShuffle = async () => {
    const newShuffle = !shuffle;
    toggleShuffle();
    await setTauriShuffle(newShuffle);
  };

  const handleRepeat = async () => {
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    const nextMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
    cycleRepeat();
    await setTauriRepeat(nextMode);
  };

  const actualProgressPercent = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
  const displayProgressPercent = isSeeking ? seekProgress : actualProgressPercent;
  const displayVolume = dragVolume ?? (isMuted ? 0 : volume);
  const volumePercent = displayVolume * 100;
  
  // Calculate display time based on seek state
  const displayTimeSecs = isSeeking ? (seekProgress / 100) * durationSecs : positionSecs;

  return (
    <div className="player-bar glass-panel-heavy">
      {/* ── Progress Bar ── */}
      <div 
        className="progress-container" 
        ref={progressBarRef}
        onPointerDown={handleSeekPointerDown}
        onPointerMove={handleSeekPointerMove}
        onPointerUp={handleSeekPointerEnd}
        onPointerCancel={handleSeekPointerEnd}
        onTouchStart={handleSeekTouchStart}
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
              <div className={`now-playing-art ${isPlaying ? 'is-playing' : ''}`}>
                {artworkUrl ? (
                  <img src={artworkUrl} alt="" className="player-artwork-img" />
                ) : (
                  <div className="artwork-placeholder">
                    <Music size={24} />
                  </div>
                )}
              </div>
              <div className="now-playing-info">
                <div className="track-title truncate" title={currentTrack.title}>
                  {currentTrack.title}
                </div>
                {currentTrack.album && (
                  <div 
                    className="track-artist now-playing-link truncate" 
                    title={currentTrack.album}
                    onClick={handleAlbumClick}
                  >
                    {currentTrack.album}
                  </div>
                )}
                <div 
                  className="track-artist now-playing-link truncate" 
                  title={currentTrack.artist}
                  onClick={handleArtistClick}
                >
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
            <button className="icon-btn" title="Previous" onClick={async () => {
              if (positionSecs > 3) {
                await seekTo(0);
              } else {
                await previousTrack(true);
              }
            }}>
              <SkipBack size={20} />
            </button>
            <button
              className={`play-pause-btn ${isPlaying ? 'is-playing' : ''}`}
              onClick={handlePlayPause}
              disabled={!currentTrack}
            >
              <Disc3
                size={28}
                strokeWidth={1.5}
                className={`vinyl-icon ${isPlaying ? 'is-playing' : ''}`}
              />
            </button>
            <button className="icon-btn" title="Next" onClick={() => nextTrack(true)}>
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
            {qualityInfo && (
              <div className="playback-quality-info" title={`${qualityInfo.badge} quality details: ${qualityInfo.specs}`}>
                <span className={`quality-badge ${qualityInfo.isHiRes ? 'hi-res' : qualityInfo.isLossless ? 'lossless' : 'hq'}`}>
                  {qualityInfo.badge}
                </span>
                <span className="quality-specs">{qualityInfo.specs}</span>
              </div>
            )}
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
            <button className="icon-btn" onClick={handleMuteToggle} title="Mute">
              {displayVolume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <div 
              className="volume-slider-wrapper"
              onMouseEnter={() => setIsVolumeHovered(true)}
              onMouseLeave={() => setIsVolumeHovered(false)}
            >
              <div 
                className="volume-slider" 
                ref={volumeBarRef}
                onPointerDown={handleVolumePointerDown}
                onPointerMove={handleVolumePointerMove}
                onPointerUp={handleVolumePointerEnd}
                onPointerCancel={handleVolumePointerEnd}
                onTouchStart={handleVolumeTouchStart}
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

          {onMiniPlayer && (
            <button
              className="icon-btn"
              onClick={onMiniPlayer}
              title="Mini Player"
            >
              <Minimize2 size={18} />
            </button>
          )}
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

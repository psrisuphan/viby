import { useRef, useState, useEffect } from 'react';
import {
  SkipBack, SkipForward,
  Volume2, VolumeX, Shuffle, Repeat,
  ListMusic, Maximize2, Minimize2, Music, Disc3, SlidersHorizontal
} from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { usePlaybackProgressStore } from '../../stores/playbackProgressStore';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatTime } from '../../utils/formatTime';
import { 
  pausePlayback, resumePlayback, 
  seekTo, setVolume as setRustVolume,
  nextTrack, previousTrack,
  toggleMutePlayback, toggleShufflePlayback, cycleRepeatPlayback,
  clearTrackEqOverride,
  getTrackEqOverride,
  previewTrackEqOverride,
  showTheaterMode,
} from '../../utils/tauri';
import { useToastStore } from '../../stores/toastStore';
import type { Track, TrackEqOverride } from '../../types';
import { useArtwork } from '../../utils/useArtwork';
import { getPlaybackQualityInfo } from '../../utils/quality';
import { usePrefersReducedMotion } from '../../utils/usePrefersReducedMotion';
import TrackGraphicEqModal from '../player/TrackGraphicEqModal';
import './PlayerBar.css';

function PlayerProgressBar({ currentTrack, isPlaying, reduceVisualEffects, prefersReducedMotion }: {
  currentTrack: Track | null;
  isPlaying: boolean;
  reduceVisualEffects: boolean;
  prefersReducedMotion: boolean;
}) {
  const positionSecs = usePlaybackProgressStore((s) => s.positionSecs);
  const durationSecs = usePlaybackProgressStore((s) => s.durationSecs);
  const seekPercent = usePlaybackProgressStore((s) => s.seekPercent);
  const setSeekPercent = usePlaybackProgressStore((s) => s.setSeekPercent);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);
  const smoothProgress = isPlaying && !prefersReducedMotion && !reduceVisualEffects;
  const visualPositionSecs = smoothProgress
    ? Math.min(positionSecs + 0.1, durationSecs)
    : positionSecs;
  const actualProgressPercent = durationSecs > 0 ? (visualPositionSecs / durationSecs) * 100 : 0;
  const displayProgressPercent = Math.max(
    0,
    Math.min(100, seekPercent === null ? actualProgressPercent : seekPercent * 100),
  );

  const seekPercentFromClientX = (clientX: number) => {
    if (!currentTrack || !progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  };

  const handleSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!currentTrack) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekingRef.current = true;
    const percent = seekPercentFromClientX(e.clientX);
    if (percent !== undefined) setSeekPercent(percent);
  };

  const handleSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    e.preventDefault();
    const percent = seekPercentFromClientX(e.clientX);
    if (percent !== undefined) setSeekPercent(percent);
  };

  const handleSeekPointerEnd = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    seekingRef.current = false;
    const finalPercent = seekPercentFromClientX(e.clientX);
    if (finalPercent !== undefined) await seekTo(finalPercent * durationSecs);
    setTimeout(() => setSeekPercent(null), 300);
  };

  return (
    <div
      className="progress-container"
      ref={progressBarRef}
      onPointerDown={handleSeekPointerDown}
      onPointerMove={handleSeekPointerMove}
      onPointerUp={handleSeekPointerEnd}
      onPointerCancel={handleSeekPointerEnd}
    >
      <div className="progress-bar-bg">
        <div
          className={`progress-bar-fill${smoothProgress ? ' is-smoothing' : ''}${seekPercent !== null ? ' is-seeking' : ''}`}
          style={{ transform: `scaleX(${displayProgressPercent / 100})` }}
        />
        <div
          className={`progress-bar-thumb${smoothProgress ? ' is-smoothing' : ''}${seekPercent !== null ? ' is-seeking' : ''}`}
          style={{ left: `${displayProgressPercent}%` }}
        />
      </div>
    </div>
  );
}

function PlayerTimeDisplay({ qualityInfo }: {
  qualityInfo: ReturnType<typeof getPlaybackQualityInfo>;
}) {
  const positionSecs = usePlaybackProgressStore((s) => s.positionSecs);
  const durationSecs = usePlaybackProgressStore((s) => s.durationSecs);
  const seekPercent = usePlaybackProgressStore((s) => s.seekPercent);
  const displayTimeSecs = seekPercent === null ? positionSecs : seekPercent * durationSecs;

  return (
    <div className="time-display">
      <span>{formatTime(displayTimeSecs)}</span>
      {qualityInfo && (
        <div className="playback-quality-info quality-info--center" title={`${qualityInfo.badge} quality details: ${qualityInfo.specs}`}>
          <span className={`quality-badge ${qualityInfo.isHiRes ? 'hi-res' : qualityInfo.isLossless ? 'lossless' : 'hq'}`}>
            {qualityInfo.badge}
          </span>
          <span className="quality-specs">{qualityInfo.specs}</span>
        </div>
      )}
      <span>{formatTime(durationSecs)}</span>
    </div>
  );
}

interface PlayerBarProps {
  onMiniPlayer?: () => void;
  onTheaterMode?: () => void;
}

export default function PlayerBar({ onMiniPlayer, onTheaterMode }: PlayerBarProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduceVisualEffects = useSettingsStore((s) => s.reduceVisualEffects);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const sampleRate = usePlayerStore((s) => s.sampleRate);
  const bitsPerSample = usePlayerStore((s) => s.bitsPerSample);
  const audioPath = usePlayerStore((s) => s.audioPath);
  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
	  
  const isQueueOpen = useUiStore((s) => s.isQueueOpen);
  const setQueueOpen = useUiStore((s) => s.setQueueOpen);
  const isTrackDetailsOpen = useUiStore((s) => s.isTrackDetailsOpen);
  const setTrackDetailsOpen = useUiStore((s) => s.setTrackDetailsOpen);
  const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
  const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
  const albums = useLibraryStore((s) => s.albums);
  const artists = useLibraryStore((s) => s.artists);
  const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);
  
  const volumeBarRef = useRef<HTMLDivElement>(null);
  
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const [isVolumeHovered, setIsVolumeHovered] = useState(false);
  const [isTrackEqOpen, setIsTrackEqOpen] = useState(false);
  const [trackEqOverride, setTrackEqOverride] = useState<TrackEqOverride | null>(null);
  const [trackEqAnchorRect, setTrackEqAnchorRect] = useState<DOMRect | null>(null);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const volumeDraggingRef = useRef(false);
  const dragVolumeRef = useRef<number | null>(null);
  const volumeRafRef = useRef<number | null>(null);
  
  const currentTrackRef = useRef<string | undefined>(currentTrack?.id);
  const { artworkUrl } = useArtwork(
    currentTrack?.id || null,
    currentTrack ? `${currentTrack.album}||${currentTrack.album_artist}` : undefined,
    { size: 128 },
  );

  useEffect(() => {
    if (currentTrack && currentTrack.id !== currentTrackRef.current) {
      useToastStore.getState().addToast(`Now playing: ${currentTrack.title}`, 'info');
      currentTrackRef.current = currentTrack.id;
    }
  }, [currentTrack]);

  useEffect(() => {
    let cancelled = false;
    if (!currentTrack) {
      setTrackEqOverride(null);
      setIsTrackEqOpen(false);
      setTrackEqAnchorRect(null);
      return;
    }

    getTrackEqOverride(currentTrack.id)
      .then((override) => {
        if (cancelled) return;
        setTrackEqOverride(override);
        if (override) {
          return previewTrackEqOverride(
            override.enabled,
            override.preamp_db,
            override.gains,
          );
        }
        return clearTrackEqOverride();
      })
      .catch((err) => console.error('Failed to load track EQ override:', err));

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id]);

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
      setSelectedAlbum(albumObj);
    }
  };

  const handleArtistClick = () => {
    if (!currentTrack) return;
    const artistObj =
      artists.find((a) => a.name === currentTrack.album_artist) ||
      artists.find((a) => a.name === currentTrack.artist);

    if (artistObj) {
      setSelectedArtist(artistObj);
    }
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
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setVolumeFromClientX(e.clientX);
    volumeDraggingRef.current = true;
    setIsVolumeDragging(true);
  };

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeDraggingRef.current) return;
    e.preventDefault();
    setVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const finalVolume = getVolumeFromClientX(e.clientX) ?? dragVolumeRef.current;
    if (finalVolume !== null) {
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
  
  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      if (volumeRafRef.current !== null) {
        cancelAnimationFrame(volumeRafRef.current);
      }
    };
  }, []);

  const handleMuteToggle = async () => {
    await toggleMutePlayback();
  };

  const handleShuffle = async () => {
    await toggleShufflePlayback();
  };

  const handleRepeat = async () => {
    await cycleRepeatPlayback();
  };

  const displayVolume = dragVolume ?? (isMuted ? 0 : volume);
  const volumePercent = displayVolume * 100;

  return (
    <div className="player-bar glass-panel-heavy">
      {/* ── Progress Bar ── */}
      <PlayerProgressBar
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        reduceVisualEffects={reduceVisualEffects}
        prefersReducedMotion={prefersReducedMotion}
      />

      <div className="player-content">
        {/* ── Left: Now Playing Info ── */}
        <div className="player-left">
          {currentTrack ? (
            <>
              <button
                type="button"
                className={`now-playing-art ${isPlaying ? 'is-playing' : ''} ${isTrackDetailsOpen ? 'is-active' : ''}`}
                onClick={() => setTrackDetailsOpen(!isTrackDetailsOpen)}
                title="Track details"
                aria-label="Show track details"
                aria-expanded={isTrackDetailsOpen}
              >
                {artworkUrl ? (
                  <img src={artworkUrl} alt="" className="player-artwork-img" />
                ) : (
                  <div className="artwork-placeholder">
                    <Music size={24} />
                  </div>
                )}
              </button>
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
                {qualityInfo && (
                  <div className="playback-quality-info quality-info--left" title={`${qualityInfo.badge} quality details: ${qualityInfo.specs}`}>
                    <span className={`quality-badge ${qualityInfo.isHiRes ? 'hi-res' : qualityInfo.isLossless ? 'lossless' : 'hq'}`}>
                      {qualityInfo.badge}
                    </span>
                    <span className="quality-specs">{qualityInfo.specs}</span>
                  </div>
                )}
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
              className={`icon-btn shuffle-btn ${shuffle ? 'active' : ''}`}
              onClick={handleShuffle}
              title="Shuffle"
            >
              <Shuffle size={18} />
            </button>
            <button className="icon-btn" title="Previous" onClick={async () => {
              if (usePlaybackProgressStore.getState().positionSecs > 3) {
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
              aria-label={isPlaying ? 'Pause' : 'Play'}
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
              className={`icon-btn repeat-btn ${repeatMode !== 'off' ? 'active' : ''}`}
              onClick={handleRepeat}
              title={`Repeat: ${repeatMode}`}
            >
              <Repeat size={18} />
              {repeatMode === 'one' && <span className="repeat-one-badge">1</span>}
            </button>
          </div>
          <PlayerTimeDisplay qualityInfo={qualityInfo} />
        </div>

        {/* ── Right: Extra Controls ── */}
        <div className="player-right">
          <button
            className={`icon-btn track-eq-btn ${trackEqOverride ? 'active' : ''}`}
            onClick={(event) => {
              if (!currentTrack) return;
              setTrackEqAnchorRect(event.currentTarget.getBoundingClientRect());
              setIsTrackEqOpen(true);
            }}
            disabled={!currentTrack}
            title={trackEqOverride ? 'Track EQ override active' : 'Track EQ'}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button 
            className={`icon-btn queue-btn ${isQueueOpen ? 'active' : ''}`}
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
              className={`volume-slider-wrapper${isVolumeDragging ? ' is-dragging' : ''}`}
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
            className="icon-btn theater-btn"
            onClick={() => {
              if (onTheaterMode) onTheaterMode();
              else void showTheaterMode();
            }}
            title="Theater Mode"
          >
            <Maximize2 size={18} />
          </button>
        </div>
      </div>
      {isTrackEqOpen && currentTrack && trackEqAnchorRect && (
        <TrackGraphicEqModal
          track={currentTrack}
          trackOverride={trackEqOverride}
          anchorRect={trackEqAnchorRect}
          onSaved={setTrackEqOverride}
          onDeleted={() => setTrackEqOverride(null)}
          onClose={() => setIsTrackEqOpen(false)}
        />
      )}
    </div>
  );
}

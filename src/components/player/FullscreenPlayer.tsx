import { useRef, useState, useEffect, useLayoutEffect } from 'react';
import {
  X, SkipBack, SkipForward, Shuffle, Repeat,
  Volume2, VolumeX, Music, Play, ChevronDown,
  Disc3, Trash2,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { useArtwork } from '../../utils/useArtwork';
import { formatTime } from '../../utils/formatTime';
import {
  pausePlayback, resumePlayback, seekTo,
  setVolume as setRustVolume,
  nextTrack, previousTrack,
  setShuffle as setTauriShuffle,
  setRepeat as setTauriRepeat,
  playQueueIndex, removeFromQueue, clearUpNext, clearHistory,
} from '../../utils/tauri';
import type { RepeatMode, Track } from '../../types';
import './FullscreenPlayer.css';

// ─── Queue item ───────────────────────────────────────────────────────────────

function FullscreenQueueItem({
  track, isActive, isPlaying, onPlay, onRemove,
}: {
  track: Track;
  isActive?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  const { artworkUrl } = useArtwork(track.id);

  return (
    <div className={`fs-queue-item${isActive ? ' active' : ''}`} onDoubleClick={onPlay}>
      <div className="fs-queue-art">
        {artworkUrl
          ? <img src={artworkUrl} alt="" />
          : <Music size={13} className="text-tertiary" />}
        <button className="fs-queue-play-btn" onClick={onPlay}>
          <Play size={11} fill="currentColor" style={{ marginLeft: 1 }} />
        </button>
      </div>
      <div className="fs-queue-info">
        <div className="fs-queue-title truncate">{track.title}</div>
        <div className="fs-queue-artist truncate">{track.artist}</div>
      </div>
      {isActive && (
        <div className={`fs-eq${isPlaying ? ' playing' : ''}`} aria-hidden>
          <span /><span /><span /><span />
        </div>
      )}
      {!isActive && onRemove && (
        <button className="fs-queue-remove" onClick={e => { e.stopPropagation(); onRemove(); }}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FullscreenPlayer() {
  const { setTheaterMode } = useUiStore();
  const {
    isPlaying, currentTrack, positionSecs, durationSecs,
    volume, isMuted, shuffle, repeatMode,
    setIsPlaying, toggleMute, setVolume, toggleShuffle, cycleRepeat,
  } = usePlayerStore();
  const { tracks, currentIndex } = useQueueStore();
  const { artworkUrl } = useArtwork(currentTrack?.id || null);

  // ── Seek ──
  const progressRef = useRef<HTMLDivElement>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPct, setSeekPct] = useState(0);

  const handleSeekDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentTrack || !progressRef.current) return;
    setIsSeeking(true);
    const rect = progressRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    setSeekPct(pct * 100);

    const onMove = (mv: MouseEvent) => {
      const p = Math.max(0, Math.min((mv.clientX - rect.left) / rect.width, 1));
      setSeekPct(p * 100);
    };
    const onUp = async (up: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalPct = Math.max(0, Math.min((up.clientX - rect.left) / rect.width, 1));
      await seekTo(finalPct * durationSecs);
      setTimeout(() => setIsSeeking(false), 300);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Volume ──
  const volumeRef = useRef<HTMLDivElement>(null);
  const applyVolume = async (e: MouseEvent | React.MouseEvent) => {
    if (!volumeRef.current) return;
    const rect = volumeRef.current.getBoundingClientRect();
    const vol = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    setVolume(vol);
    await setRustVolume(vol);
  };

  const handleVolumeDown = (e: React.MouseEvent<HTMLDivElement>) => {
    applyVolume(e);
    const onMove = (mv: MouseEvent) => applyVolume(mv);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Controls ──
  const handlePlayPause = async () => {
    if (!currentTrack) return;
    if (isPlaying) { setIsPlaying(false); await pausePlayback(); }
    else { setIsPlaying(true); await resumePlayback(); }
  };

  const handleMute = async () => {
    const { isMuted, previousVolume } = usePlayerStore.getState();
    toggleMute();
    await setRustVolume(isMuted ? (previousVolume || 1) : 0);
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

  // ── Close on Escape ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTheaterMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTheaterMode]);

  // ── Queue sections ──
  const previousTracks = currentIndex !== null && currentIndex > 0
    ? tracks.slice(0, currentIndex) : [];
  const upNextTracks = currentIndex !== null
    ? tracks.slice(currentIndex + 1) : [];

  const [showHistory, setShowHistory] = useState(false);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const upNextListRef = useRef<HTMLDivElement>(null);
  const [queueScrollMargin, setQueueScrollMargin] = useState(0);

  useLayoutEffect(() => {
    if (!queueScrollRef.current || !upNextListRef.current) return;
    const listTop = upNextListRef.current.getBoundingClientRect().top;
    const containerTop = queueScrollRef.current.getBoundingClientRect().top;
    setQueueScrollMargin(listTop - containerTop + queueScrollRef.current.scrollTop);
  }, [showHistory, currentIndex, upNextTracks.length]);

  const upNextVirtualizer = useVirtualizer({
    count: upNextTracks.length,
    getScrollElement: () => queueScrollRef.current,
    estimateSize: () => 52,
    overscan: 8,
    scrollMargin: queueScrollMargin,
  });

  // ── Derived display values ──
  const displayPct = isSeeking ? seekPct : (durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0);
  const displayTime = isSeeking ? (seekPct / 100) * durationSecs : positionSecs;
  const volPct = isMuted ? 0 : volume * 100;

  return (
    <div className="fs-player animate-fade-in">
      {/* Blurred backdrop */}
      <div className="fs-backdrop">
        {artworkUrl && <img src={artworkUrl} alt="" className="fs-backdrop-img" />}
        <div className="fs-backdrop-overlay" />
      </div>

      {/* Close button */}
      <button className="fs-close-btn" onClick={() => setTheaterMode(false)} title="Exit fullscreen (Esc)">
        <ChevronDown size={22} />
      </button>

      {/* Content */}
      <div className="fs-content">
        {/* ── Left: artwork + controls ── */}
        <div className="fs-left">
          <div className="fs-artwork-wrap">
            {artworkUrl
              ? <img src={artworkUrl} alt={currentTrack?.title} className={`fs-artwork${isPlaying ? ' playing' : ''}`} />
              : <div className="fs-artwork-placeholder"><Music size={80} /></div>}
          </div>

          <div className="fs-track-info">
            <div className="fs-track-title truncate">{currentTrack?.title ?? '—'}</div>
            <div className="fs-track-artist truncate">
              {currentTrack
                ? `${currentTrack.artist}${currentTrack.album ? ` · ${currentTrack.album}` : ''}`
                : 'No track playing'}
            </div>
          </div>

          {/* Progress */}
          <div className="fs-progress-wrap">
            <span className="fs-time">{formatTime(displayTime)}</span>
            <div className="fs-progress-bar" ref={progressRef} onMouseDown={handleSeekDown}>
              <div className="fs-progress-bg">
                <div className="fs-progress-fill" style={{ width: `${displayPct}%` }} />
                <div className="fs-progress-thumb" style={{ left: `${displayPct}%` }} />
              </div>
            </div>
            <span className="fs-time">{formatTime(durationSecs)}</span>
          </div>

          {/* Playback controls */}
          <div className="fs-controls">
            <button className={`fs-ctrl-btn${shuffle ? ' active' : ''}`} onClick={handleShuffle} title="Shuffle">
              <Shuffle size={20} />
            </button>
            <button className="fs-ctrl-btn" title="Previous" onClick={async () => {
              positionSecs > 3 ? await seekTo(0) : await previousTrack(true);
            }}>
              <SkipBack size={24} />
            </button>
            <button className="fs-play-btn" onClick={handlePlayPause} disabled={!currentTrack}>
              <Disc3 size={36} strokeWidth={1.5} className={`vinyl-icon${isPlaying ? ' is-playing' : ''}`} />
            </button>
            <button className="fs-ctrl-btn" title="Next" onClick={() => nextTrack(true)}>
              <SkipForward size={24} />
            </button>
            <button className={`fs-ctrl-btn${repeatMode !== 'off' ? ' active' : ''}`} onClick={handleRepeat} title={`Repeat: ${repeatMode}`}>
              <Repeat size={20} />
              {repeatMode === 'one' && <span className="fs-repeat-badge">1</span>}
            </button>
          </div>

          {/* Volume */}
          <div className="fs-volume">
            <button className="fs-ctrl-btn" onClick={handleMute}>
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <div className="fs-vol-slider" ref={volumeRef} onMouseDown={handleVolumeDown}>
              <div className="fs-vol-bg">
                <div className="fs-vol-fill" style={{ width: `${volPct}%` }} />
                <div className="fs-vol-thumb" style={{ left: `${volPct}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Right: queue ── */}
        <div className="fs-queue">
          <div className="fs-queue-header">
            <span>Play Queue</span>
          </div>

          <div className="fs-queue-scroll" ref={queueScrollRef}>
            {/* Previously Played */}
            {previousTracks.length > 0 && (
              <div className="fs-queue-section">
                <div
                  className="fs-queue-section-label clickable"
                  onClick={() => setShowHistory(h => !h)}
                >
                  <span>{showHistory ? '▾' : '▸'} Previously Played ({previousTracks.length})</span>
                  <button
                    className="fs-queue-action-btn"
                    onClick={e => { e.stopPropagation(); clearHistory(); }}
                    title="Clear history"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {showHistory && (
                  <div style={{ opacity: 0.55 }}>
                    {previousTracks.map((track, i) => (
                      <FullscreenQueueItem
                        key={`prev-${track.id}-${i}`}
                        track={track}
                        onPlay={() => playQueueIndex(i)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Now Playing */}
            {currentTrack && currentIndex !== null && (
              <div className="fs-queue-section">
                <div className="fs-queue-section-label">Now Playing</div>
                <FullscreenQueueItem
                  track={currentTrack}
                  isActive
                  isPlaying={isPlaying}
                  onPlay={() => playQueueIndex(currentIndex)}
                />
              </div>
            )}

            {/* Up Next — virtualized */}
            <div className="fs-queue-section">
              <div className="fs-queue-section-label">
                <span>Up Next</span>
                {upNextTracks.length > 0 && (
                  <button className="fs-queue-action-btn" onClick={() => clearUpNext()} title="Clear up next">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {upNextTracks.length === 0 ? (
                <div className="fs-queue-empty">Nothing up next</div>
              ) : (
                <div
                  ref={upNextListRef}
                  style={{ position: 'relative', height: `${upNextVirtualizer.getTotalSize()}px` }}
                >
                  {upNextVirtualizer.getVirtualItems().map((vRow) => {
                    const track = upNextTracks[vRow.index];
                    const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + vRow.index;
                    return (
                      <div
                        key={`${track.id}-${actualIdx}`}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${vRow.size}px`,
                          transform: `translateY(${vRow.start - queueScrollMargin}px)`,
                        }}
                      >
                        <FullscreenQueueItem
                          track={track}
                          onPlay={() => playQueueIndex(actualIdx)}
                          onRemove={() => removeFromQueue(actualIdx)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

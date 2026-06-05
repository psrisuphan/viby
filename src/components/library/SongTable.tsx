import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play, ListPlus } from 'lucide-react';
import type { Track } from '../../types';
import { formatTime } from '../../utils/formatTime';
import { usePlayerStore } from '../../stores/playerStore';
import { useToastStore } from '../../stores/toastStore';
import { playTrack, addToQueue } from '../../utils/tauri';
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu';
import { useState, memo } from 'react';
import { useArtwork } from '../../utils/useArtwork';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import AddToPlaylistModal from '../playlist/AddToPlaylistModal';
import { Disc } from 'lucide-react';
import './SongTable.css';

interface SongTableProps {
  tracks: Track[];
  hideAlbumColumn?: boolean;
  hideArtwork?: boolean;
}

interface SongRowProps {
  track: Track;
  isCurrent: boolean;
  isPlaying: boolean;
  virtualRow: any;
  hideAlbumColumn?: boolean;
  hideArtwork?: boolean;
  onPlay: (track: Track) => void;
  onContextMenu: (e: React.MouseEvent, track: Track) => void;
  onAlbumClick?: (track: Track) => void;
}

const SongRow = memo(({ track, isCurrent, isPlaying, virtualRow, hideAlbumColumn, hideArtwork, onPlay, onContextMenu, onAlbumClick }: SongRowProps) => {
  const { artworkUrl } = useArtwork(!hideArtwork ? track.id : null);

  return (
    <div
      className={`song-row ${isCurrent ? 'active' : ''}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: `${virtualRow.size}px`,
        transform: `translateY(${virtualRow.start}px)`,
      }}
      onDoubleClick={() => onPlay(track)}
      onContextMenu={(e) => onContextMenu(e, track)}
    >
      <div className="col-play">
        <span className="track-number">{track.track_number || virtualRow.index + 1}</span>
        <button 
          className="row-play-btn"
          onClick={() => onPlay(track)}
        >
          <Play size={16} fill="currentColor" />
        </button>
        {isCurrent && isPlaying && (
          <div className="playing-indicator" />
        )}
      </div>
      <div className="col-title truncate" title={track.title}>
        {!hideArtwork && (
          <div className="row-artwork">
            {artworkUrl ? (
              <img src={artworkUrl} alt="" className="row-artwork-img" />
            ) : (
              <div className="row-artwork-placeholder">
                <Disc size={16} />
              </div>
            )}
          </div>
        )}
        <span>{track.title}</span>
      </div>
      <div className="col-artist truncate" title={track.artist}>{track.artist}</div>
      {!hideAlbumColumn && (
        <div 
          className="col-album truncate clickable" 
          title={track.album}
          onClick={(e) => {
            if (onAlbumClick) {
              e.stopPropagation();
              onAlbumClick(track);
            }
          }}
        >
          {track.album}
        </div>
      )}
      <div className="col-time">{formatTime(track.duration_secs)}</div>
    </div>
  );
});

export default function SongTable({ tracks, hideAlbumColumn, hideArtwork }: SongTableProps) {
  const { currentTrack, isPlaying } = usePlayerStore();
  const { setSelectedAlbum, setActiveLibraryView, setActiveSection } = useUiStore();
  const { albums } = useLibraryStore();
  const parentRef = useRef<HTMLDivElement>(null);
  
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, track: Track } | null>(null);
  const [selectedTrackForPlaylist, setSelectedTrackForPlaylist] = useState<Track | null>(null);

  // Virtualizer for handling large lists (e.g. 20,000+ songs) smoothly
  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Fixed row height of 48px
    overscan: 10, // Render 10 items outside of viewport to prevent flickering
  });

  const handlePlay = async (track: Track) => {
    await playTrack(track.file_path);
  };
  
  const handleAddToQueue = async (track: Track) => {
    await addToQueue(track);
    useToastStore.getState().addToast(`Added "${track.title}" to queue`, 'success');
  };

  const handleContextMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, track });
  };

  const handleAlbumClick = (track: Track) => {
    // Find the full album object. Try to match album_artist first, then artist, then just name.
    const albumObj = albums.find(a => a.name === track.album && a.artist === track.album_artist)
      || albums.find(a => a.name === track.album && a.artist === track.artist)
      || albums.find(a => a.name === track.album);
      
    if (albumObj) {
      setActiveSection('library');
      setActiveLibraryView('albums');
      setSelectedAlbum(albumObj);
    }
  };

  const getContextMenuItems = (track: Track): ContextMenuItem[] => [
    {
      label: 'Play',
      icon: <Play size={14} />,
      onClick: () => handlePlay(track)
    },
    {
      label: 'Add to Queue',
      icon: <ListPlus size={14} />,
      onClick: () => handleAddToQueue(track)
    },
    {
      label: 'Add to Playlist...',
      icon: <ListPlus size={14} />,
      onClick: () => {
        setSelectedTrackForPlaylist(track);
      }
    }
  ];

  if (tracks.length === 0) {
    return (
      <div className="empty-state">
        <p>No songs found in your library.</p>
      </div>
    );
  }

  return (
    <div className="song-table-container" ref={parentRef}>
      <div className="song-table-header">
        <div className="col-play">#</div>
        <div className="col-title">Title</div>
        <div className="col-artist">Artist</div>
        {!hideAlbumColumn && <div className="col-album">Album</div>}
        <div className="col-time">Time</div>
      </div>
      
      <div 
        className="song-table-body" 
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const track = tracks[virtualRow.index];
          const isCurrent = currentTrack?.id === track.id;

          return (
            <SongRow
              key={track.id}
              track={track}
              isCurrent={isCurrent}
              isPlaying={isPlaying}
              virtualRow={virtualRow}
              hideAlbumColumn={hideAlbumColumn}
              hideArtwork={hideArtwork}
              onPlay={handlePlay}
              onContextMenu={handleContextMenu}
              onAlbumClick={handleAlbumClick}
            />
          );
        })}
      </div>
      
      {contextMenu && (
        <ContextMenu 
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.track)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {selectedTrackForPlaylist && (
        <AddToPlaylistModal 
          track={selectedTrackForPlaylist} 
          onClose={() => setSelectedTrackForPlaylist(null)} 
        />
      )}
    </div>
  );
}

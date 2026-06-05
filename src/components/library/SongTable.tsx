import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play, ListPlus } from 'lucide-react';
import type { Track } from '../../types';
import { formatTime } from '../../utils/formatTime';
import { usePlayerStore } from '../../stores/playerStore';
import { useToastStore } from '../../stores/toastStore';
import { playTrack, addToQueue } from '../../utils/tauri';
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu';
import { useState } from 'react';
import './SongTable.css';

interface SongTableProps {
  tracks: Track[];
}

export default function SongTable({ tracks }: SongTableProps) {
  const { currentTrack, isPlaying } = usePlayerStore();
  const parentRef = useRef<HTMLDivElement>(null);
  
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, track: Track } | null>(null);

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
        <div className="col-play"></div>
        <div className="col-title">Title</div>
        <div className="col-artist">Artist</div>
        <div className="col-album">Album</div>
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
            <div
              key={track.id}
              className={`song-row ${isCurrent ? 'active' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onDoubleClick={() => handlePlay(track)}
              onContextMenu={(e) => handleContextMenu(e, track)}
            >
              <div className="col-play">
                <button 
                  className="row-play-btn"
                  onClick={() => handlePlay(track)}
                >
                  <Play size={16} fill="currentColor" />
                </button>
                {isCurrent && isPlaying && (
                  <div className="playing-indicator" />
                )}
              </div>
              <div className="col-title truncate" title={track.title}>{track.title}</div>
              <div className="col-artist truncate" title={track.artist}>{track.artist}</div>
              <div className="col-album truncate" title={track.album}>{track.album}</div>
              <div className="col-time">{formatTime(track.duration_secs)}</div>
            </div>
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
    </div>
  );
}

import { X, Play, GripVertical, ChevronDown, ChevronRight, Trash2, Music } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { clearQueue, clearUpNext, clearHistory, removeFromQueue, reorderQueue, playQueueIndex } from '../../utils/tauri';
import { useState } from 'react';
import { useArtwork } from '../../utils/useArtwork';
import type { Track } from '../../types';
import './QueuePanel.css';

interface QueueItemRowProps {
  track: Track;
  isDragged?: boolean;
  dropIndicatorClass?: string;
  isActive?: boolean;
  onPlayClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnter?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onRemove?: (e: React.MouseEvent) => void;
  showDragHandle?: boolean;
}

function QueueItemRow({
  track, isDragged, dropIndicatorClass, isActive,
  onPlayClick, onDoubleClick, onDragStart, onDragEnter, onDragOver, onDrop, onDragEnd, onRemove, showDragHandle
}: QueueItemRowProps) {
  const { artworkUrl } = useArtwork(track.id);

  return (
    <div 
      className={`queue-item ${isDragged ? 'is-dragged' : ''} ${dropIndicatorClass || ''} ${isActive ? 'active' : ''}`}
      onDoubleClick={onDoubleClick}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button 
        className="queue-item-play-btn"
        onClick={onPlayClick}
      >
        <Play size={14} fill="currentColor" style={{ marginLeft: '2px' }} />
      </button>

      <div className="queue-item-art">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="queue-item-art-img" />
        ) : (
          <Music size={14} className="text-tertiary" />
        )}
      </div>

      <div className="queue-item-info">
        <div className="queue-item-title truncate">{track.title}</div>
        <div className="queue-item-artist truncate">{track.artist}</div>
      </div>

      {showDragHandle && onRemove && (
        <div className="queue-item-actions">
          <div className="drag-handle" title="Drag to reorder">
            <GripVertical size={16} />
          </div>
          <button 
            className="icon-btn--sm queue-item-remove" 
            onClick={onRemove}
            title="Remove from queue"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function QueuePanel() {
  const { setQueueOpen } = useUiStore();
  const { tracks, currentIndex } = useQueueStore();
  
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [debugMsg, setDebugMsg] = useState<string>("");

  const handleClearAll = async () => {
    await clearQueue();
  };

  const handleClearHistory = async () => {
    await clearHistory();
  };

  const handleClearUpNext = async () => {
    await clearUpNext();
  };

  const handleRemove = async (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    await removeFromQueue(index);
  };

  const handlePlay = async (index: number) => {
    await playQueueIndex(index);
  };

  const handleDragStart = (e: React.DragEvent, actualIdx: number) => {
    setDraggedIndex(actualIdx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', actualIdx.toString());
    setDebugMsg(`Drag started: ${actualIdx}`);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, actualIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    try {
      const draggedIdxStr = e.dataTransfer.getData('text/plain');
      let sourceIdx = draggedIndex;
      
      if (draggedIdxStr) {
        sourceIdx = parseInt(draggedIdxStr, 10);
      }
      
      setDebugMsg(`Dropped: from ${sourceIdx} to ${actualIdx}`);
      
      if (sourceIdx !== null && sourceIdx !== actualIdx) {
        await reorderQueue(sourceIdx, actualIdx);
        setDebugMsg(`Reorder success: ${sourceIdx} -> ${actualIdx}`);
      }
    } catch (err: any) {
      setDebugMsg(`Drop error: ${err.message || err.toString()}`);
    }
    
    setDraggedIndex(null);
    setDropTargetIndex(null);
  };

  const handleListDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleListDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // Catch-all to clear state if dropped on the list but not on an item
    setDraggedIndex(null);
    setDropTargetIndex(null);
    setDebugMsg("Dropped on empty space in list");
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
  };

  const currentTrack = currentIndex !== null && currentIndex >= 0 && currentIndex < tracks.length
    ? tracks[currentIndex]
    : null;

  const upNextTracks = currentIndex !== null && currentIndex >= 0 
    ? tracks.slice(currentIndex + 1)
    : [];
    
  const previousTracks = currentIndex !== null && currentIndex >= 0
    ? tracks.slice(0, currentIndex)
    : (tracks.length > 0 ? tracks : []);

  return (
    <aside className="queue-panel animate-slide-right">
      <div className="queue-header">
        <h2>Play Queue</h2>
        <div className="queue-actions">
          {debugMsg && <span style={{ color: 'red', fontSize: '10px' }}>{debugMsg}</span>}
          <button className="icon-btn--sm" onClick={handleClearAll} title="Clear entire queue">
            <span className="text-xs">Clear All</span>
          </button>
          <button className="icon-btn" onClick={() => setQueueOpen(false)}>
            <X size={20} />
          </button>
        </div>
      </div>
      
      <div className="queue-content">
        {previousTracks.length > 0 && (
          <div className="queue-section">
            <div 
              className="queue-section-title" 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '12px 24px', userSelect: 'none' }}
              onClick={() => setShowHistory(!showHistory)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {showHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Previously Played</span>
              </div>
              <button 
                className="icon-btn--sm" 
                onClick={(e) => { e.stopPropagation(); handleClearHistory(); }} 
                title="Clear history"
              >
                <Trash2 size={14} />
              </button>
            </div>
            
            {showHistory && (
              <div className="queue-list" style={{ opacity: 0.6 }}>
                {previousTracks.map((track, i) => (
                  <QueueItemRow
                    key={`prev-${track.id}-${i}`}
                    track={track}
                    onDoubleClick={() => handlePlay(i)}
                    onPlayClick={(e) => { e.stopPropagation(); handlePlay(i); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {currentTrack && (
          <div className="queue-section">
            <h3 className="queue-section-title">Now Playing</h3>
            <QueueItemRow
              track={currentTrack}
              isActive={true}
              onDoubleClick={() => handlePlay(currentIndex!)}
              onPlayClick={(e) => { e.stopPropagation(); handlePlay(currentIndex!); }}
            />
          </div>
        )}

        <div className="queue-section">
          <div className="queue-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px' }}>
            <span>Up Next</span>
            {upNextTracks.length > 0 && (
              <button 
                className="icon-btn--sm" 
                onClick={handleClearUpNext} 
                title="Clear up next"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {upNextTracks.length === 0 ? (
            <div className="empty-state">
              <p>Queue is empty</p>
            </div>
          ) : (
            <div 
              className="queue-list"
              onDragOver={handleListDragOver}
              onDrop={handleListDrop}
            >
              {upNextTracks.map((track, i) => {
                const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
                const isDragged = draggedIndex === actualIdx;
                const isDropTarget = dropTargetIndex === actualIdx;
                
                // Determine if we show indicator above or below
                const dropIndicatorClass = isDropTarget && draggedIndex !== null
                  ? draggedIndex < actualIdx ? 'drop-target-below' : 'drop-target-above'
                  : '';

                return (
                  <QueueItemRow
                    key={`${track.id}-${actualIdx}`}
                    track={track}
                    isDragged={isDragged}
                    dropIndicatorClass={dropIndicatorClass}
                    onDoubleClick={() => handlePlay(actualIdx)}
                    onPlayClick={(e) => { e.stopPropagation(); handlePlay(actualIdx); }}
                    onDragStart={(e) => handleDragStart(e, actualIdx)}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, actualIdx)}
                    onDragEnd={handleDragEnd}
                    onRemove={(e) => handleRemove(e, actualIdx)}
                    showDragHandle={true}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

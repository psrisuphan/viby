import { X, Play, GripVertical, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { clearQueue, clearUpNext, clearHistory, removeFromQueue, reorderQueue, playQueueIndex } from '../../utils/tauri';
import { useState } from 'react';
import './QueuePanel.css';

export default function QueuePanel() {
  const { setQueueOpen } = useUiStore();
  const { tracks, currentIndex } = useQueueStore();
  
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);

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
    // Firefox requires data to be set
    e.dataTransfer.setData('text/plain', actualIdx.toString());
  };

  const handleDragOver = (e: React.DragEvent, actualIdx: number) => {
    e.preventDefault(); // Necessary to allow drop
    if (draggedIndex === null || draggedIndex === actualIdx) return;
    setDropTargetIndex(actualIdx);
  };

  const handleDrop = async (e: React.DragEvent, actualIdx: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== actualIdx) {
      await reorderQueue(draggedIndex, actualIdx);
    }
    setDraggedIndex(null);
    setDropTargetIndex(null);
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
                  <div 
                    key={`prev-${track.id}-${i}`} 
                    className="queue-item"
                    onDoubleClick={() => handlePlay(i)}
                  >
                    <button 
                      className="queue-item-play-btn"
                      onClick={(e) => { e.stopPropagation(); handlePlay(i); }}
                    >
                      <Play size={14} className="play-icon-offset" />
                    </button>
                    <div className="queue-item-info">
                      <div className="queue-item-title truncate">{track.title}</div>
                      <div className="queue-item-artist truncate">{track.artist}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {currentTrack && (
          <div className="queue-section">
            <h3 className="queue-section-title">Now Playing</h3>
            <div 
              className="queue-item active"
              onDoubleClick={() => handlePlay(currentIndex!)}
            >
              <button 
                className="queue-item-play-btn"
                onClick={(e) => { e.stopPropagation(); handlePlay(currentIndex!); }}
              >
                <Play size={14} className="play-icon-offset" />
              </button>

              <div className="queue-item-info">
                <div className="queue-item-title truncate">{currentTrack.title}</div>
                <div className="queue-item-artist truncate">{currentTrack.artist}</div>
              </div>
            </div>
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
            <div className="queue-list" onDragLeave={handleDragEnd}>
              {upNextTracks.map((track, i) => {
                const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
                const isDragged = draggedIndex === actualIdx;
                const isDropTarget = dropTargetIndex === actualIdx;
                
                // Determine if we show indicator above or below
                const dropIndicatorClass = isDropTarget && draggedIndex !== null
                  ? draggedIndex < actualIdx ? 'drop-target-below' : 'drop-target-above'
                  : '';

                return (
                  <div 
                    key={`${track.id}-${actualIdx}`} 
                    className={`queue-item ${isDragged ? 'is-dragged' : ''} ${dropIndicatorClass}`}
                    onDoubleClick={() => handlePlay(actualIdx)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, actualIdx)}
                    onDragOver={(e) => handleDragOver(e, actualIdx)}
                    onDrop={(e) => handleDrop(e, actualIdx)}
                    onDragEnd={handleDragEnd}
                  >
                    <button 
                      className="queue-item-play-btn"
                      onClick={(e) => { e.stopPropagation(); handlePlay(actualIdx); }}
                    >
                      <Play size={14} className="play-icon-offset" />
                    </button>

                    <div className="queue-item-info">
                      <div className="queue-item-title truncate">{track.title}</div>
                      <div className="queue-item-artist truncate">{track.artist}</div>
                    </div>

                    <div className="queue-item-actions">
                      <div className="drag-handle" title="Drag to reorder">
                        <GripVertical size={16} />
                      </div>
                      <button 
                        className="icon-btn--sm queue-item-remove" 
                        onClick={(e) => handleRemove(e, actualIdx)}
                        title="Remove from queue"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

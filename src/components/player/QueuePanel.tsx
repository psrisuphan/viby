import { X, Play, GripVertical, ChevronDown, ChevronRight, Trash2, Music } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { usePlayerStore } from '../../stores/playerStore';
import { clearQueue, clearUpNext, clearHistory, removeFromQueue, reorderQueue, playQueueIndex } from '../../utils/tauri';
import { useState } from 'react';
import { useArtwork } from '../../utils/useArtwork';
import type { Track } from '../../types';
import './QueuePanel.css';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function EqVisualizer({ isPlaying }: { isPlaying: boolean }) {
  return (
    <div className={`eq-visualizer${isPlaying ? ' eq-playing' : ''}`} aria-hidden>
      <span className="eq-bar" />
      <span className="eq-bar" />
      <span className="eq-bar" />
      <span className="eq-bar" />
    </div>
  );
}

interface QueueItemRowProps {
  track: Track;
  isDragged?: boolean;
  dropIndicatorClass?: string;
  isActive?: boolean;
  isPlaying?: boolean;
  onPlayClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onRemove?: (e: React.MouseEvent) => void;
  showDragHandle?: boolean;
  dragHandleProps?: Record<string, any>;
}

function QueueItemRow({
  track, isDragged, dropIndicatorClass, isActive, isPlaying,
  onPlayClick, onDoubleClick, onRemove, showDragHandle, dragHandleProps
}: QueueItemRowProps) {
  const { artworkUrl } = useArtwork(track.id);

  return (
    <div
      className={`queue-item ${isDragged ? 'is-dragged' : ''} ${dropIndicatorClass || ''} ${isActive ? 'active' : ''}`}
      onDoubleClick={onDoubleClick}
    >
      <div className="queue-item-art">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="queue-item-art-img" />
        ) : (
          <Music size={14} className="text-tertiary" />
        )}
        <button className="queue-item-play-btn" onClick={onPlayClick}>
          <Play size={12} fill="currentColor" style={{ marginLeft: '1px' }} />
        </button>
      </div>

      <div className="queue-item-info">
        <div className="queue-item-title truncate">{track.title}</div>
        <div className="queue-item-artist truncate">{track.artist}</div>
      </div>

      {isActive && isPlaying !== undefined && (
        <EqVisualizer isPlaying={isPlaying} />
      )}

      {showDragHandle && onRemove && (
        <div className="queue-item-actions">
          <div className="drag-handle" title="Drag to reorder" style={{ cursor: 'grab' }} {...dragHandleProps}>
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

function SortableQueueItemRow(props: QueueItemRowProps & { id: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    opacity: isDragging ? 0.8 : 1,
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <QueueItemRow 
        {...props} 
        isDragged={isDragging} 
        dragHandleProps={{ ref: setActivatorNodeRef, ...attributes, ...listeners }} 
      />
    </div>
  );
}

export default function QueuePanel() {
  const { setQueueOpen } = useUiStore();
  const { tracks, currentIndex } = useQueueStore();
  const { isPlaying } = usePlayerStore();
  
  const [showHistory, setShowHistory] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // Parse actual indices from the IDs
      const oldIdxStr = (active.id as string).split('-').pop();
      const newIdxStr = (over.id as string).split('-').pop();
      
      if (oldIdxStr && newIdxStr) {
        const oldIndex = parseInt(oldIdxStr, 10);
        const newIndex = parseInt(newIdxStr, 10);
        await reorderQueue(oldIndex, newIndex);
      }
    }
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

  // Generate stable IDs for dnd-kit sortable context
  const sortableItems = upNextTracks.map((track, i) => {
    const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
    return `${track.id}-${actualIdx}`;
  });

  return (
    <aside className="queue-panel animate-slide-right">
      <div className="queue-header">
        <h2>Play Queue</h2>
        <div className="queue-actions">
          <button className="icon-btn--sm queue-clear-btn" onClick={handleClearAll} title="Clear entire queue">
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
              isPlaying={isPlaying}
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
            <DndContext 
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext 
                items={sortableItems}
                strategy={verticalListSortingStrategy}
              >
                <div className="queue-list">
                  {upNextTracks.map((track, i) => {
                    const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
                    const id = `${track.id}-${actualIdx}`;

                    return (
                      <SortableQueueItemRow
                        key={id}
                        id={id}
                        track={track}
                        onDoubleClick={() => handlePlay(actualIdx)}
                        onPlayClick={(e) => { e.stopPropagation(); handlePlay(actualIdx); }}
                        onRemove={(e) => handleRemove(e, actualIdx)}
                        showDragHandle={true}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>
    </aside>
  );
}

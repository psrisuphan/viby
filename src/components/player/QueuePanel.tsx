import { X, Play, GripVertical, ChevronDown, ChevronRight, Trash2, Music } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { usePlayerStore } from '../../stores/playerStore';
import { clearQueue, clearUpNext, clearHistory, removeFromQueue, reorderQueue, playQueueIndex } from '../../utils/tauri';
import { useState, useRef, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useArtwork } from '../../utils/useArtwork';
import type { Track } from '../../types';
import './QueuePanel.css';

import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';

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
  isActive?: boolean;
  isPlaying?: boolean;
  onPlayClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onRemove?: (e: React.MouseEvent) => void;
  showDragHandle?: boolean;
  dragHandleProps?: Record<string, any>;
}

function QueueItemRow({
  track, isDragged, isActive, isPlaying,
  onPlayClick, onDoubleClick, onRemove, showDragHandle, dragHandleProps,
}: QueueItemRowProps) {
  const { artworkUrl } = useArtwork(track.id);

  return (
    <div
      className={`queue-item ${isDragged ? 'is-dragged' : ''} ${isActive ? 'active' : ''}`}
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

// Virtual + sortable item — combines the virtualizer absolute position with dnd-kit shift transform.
// When this item is being dragged, it becomes an invisible placeholder; DragOverlay shows the copy.
function VirtualSortableQueueItemRow(props: QueueItemRowProps & {
  id: string;
  virtualStart: number;
  virtualSize: number;
  scrollMargin: number;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });

  const style: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: `${props.virtualSize}px`,
    // Dragged item: stay at virtual position (invisible placeholder); no cursor-following transform.
    // Other items: apply dnd-kit's shift transform so they animate out of the way.
    transform: isDragging
      ? `translateY(${props.virtualStart - props.scrollMargin}px)`
      : `translateY(${props.virtualStart - props.scrollMargin}px)${transform ? ` translate(${transform.x}px, ${transform.y}px)` : ''}`,
    transition,
    opacity: isDragging ? 0 : 1,
    zIndex: 0,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <QueueItemRow
        {...props}
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
  const [activeId, setActiveId] = useState<string | null>(null);

  const queueContentRef = useRef<HTMLDivElement>(null);
  const upNextListRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const currentTrack = currentIndex !== null && currentIndex >= 0 && currentIndex < tracks.length
    ? tracks[currentIndex]
    : null;

  const upNextTracks = currentIndex !== null && currentIndex >= 0
    ? tracks.slice(currentIndex + 1)
    : [];

  const previousTracks = currentIndex !== null && currentIndex >= 0
    ? tracks.slice(0, currentIndex)
    : (tracks.length > 0 ? tracks : []);

  const sortableItems = upNextTracks.map((track, i) => {
    const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
    return `${track.id}-${actualIdx}`;
  });

  // Recompute scrollMargin whenever sections above the Up Next list change height
  useLayoutEffect(() => {
    if (!queueContentRef.current || !upNextListRef.current) return;
    const listTop = upNextListRef.current.getBoundingClientRect().top;
    const containerTop = queueContentRef.current.getBoundingClientRect().top;
    setScrollMargin(listTop - containerTop + queueContentRef.current.scrollTop);
  }, [showHistory, currentIndex, upNextTracks.length]);

  const upNextVirtualizer = useVirtualizer({
    count: upNextTracks.length,
    getScrollElement: () => queueContentRef.current,
    estimateSize: () => 52, // 50px item height + 2px gap
    overscan: 8,
    scrollMargin,
  });

  const handleClearAll = async () => { await clearQueue(); };
  const handleClearHistory = async () => { await clearHistory(); };
  const handleClearUpNext = async () => { await clearUpNext(); };

  const handleRemove = async (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    await removeFromQueue(index);
  };

  const handlePlay = async (index: number) => { await playQueueIndex(index); };

  const activeTrack = activeId
    ? upNextTracks.find((track, i) => {
        const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + i;
        return `${track.id}-${actualIdx}` === activeId;
      }) ?? null
    : null;

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdxStr = (active.id as string).split('-').pop();
      const newIdxStr = (over.id as string).split('-').pop();
      if (oldIdxStr && newIdxStr) {
        await reorderQueue(parseInt(oldIdxStr, 10), parseInt(newIdxStr, 10));
      }
    }
  };

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

      <div className="queue-content" ref={queueContentRef}>
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
              <button className="icon-btn--sm" onClick={handleClearUpNext} title="Clear up next">
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
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              autoScroll={false}
            >
              <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
                <div
                  className="queue-list"
                  ref={upNextListRef}
                  style={{ position: 'relative', height: `${upNextVirtualizer.getTotalSize()}px` }}
                >
                  {upNextVirtualizer.getVirtualItems().map((virtualRow) => {
                    const track = upNextTracks[virtualRow.index];
                    const actualIdx = (currentIndex !== null ? currentIndex + 1 : 0) + virtualRow.index;
                    const id = `${track.id}-${actualIdx}`;

                    return (
                      <VirtualSortableQueueItemRow
                        key={id}
                        id={id}
                        track={track}
                        virtualStart={virtualRow.start}
                        virtualSize={virtualRow.size}
                        scrollMargin={scrollMargin}
                        onDoubleClick={() => handlePlay(actualIdx)}
                        onPlayClick={(e) => { e.stopPropagation(); handlePlay(actualIdx); }}
                        onRemove={(e) => handleRemove(e, actualIdx)}
                        showDragHandle={true}
                      />
                    );
                  })}
                </div>
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeTrack && (
                  <QueueItemRow
                    track={activeTrack}
                    isDragged
                    showDragHandle
                    onPlayClick={() => {}}
                    onDoubleClick={() => {}}
                  />
                )}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>
    </aside>
  );
}

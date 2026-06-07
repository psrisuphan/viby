import { X, Play, GripVertical, ChevronDown, ChevronRight, Trash2, Music } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import { usePlayerStore } from '../../stores/playerStore';
import { clearQueue, clearUpNext, clearHistory, removeFromQueue, reorderQueue, playQueueIndex } from '../../utils/tauri';
import { useState, useRef, useLayoutEffect, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useArtwork } from '../../utils/useArtwork';
import type { Track } from '../../types';
import './QueuePanel.css';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';

// Custom scrollbar that uses pointer capture so dragging outside the window
// still tracks correctly — native WebKitGTK scrollbars miss mouseup events
// when the cursor leaves the Tauri window, leaving scroll stuck.
function CustomScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) { setThumb(null); return; }
      const h = Math.max((clientHeight / scrollHeight) * clientHeight, 28);
      const t = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - h);
      setThumb({ top: t, height: h });
    };

    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, [scrollRef]);

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const thumbEl = e.currentTarget;
    thumbEl.setPointerCapture(e.pointerId); // keeps events coming even outside the window

    const el = scrollRef.current!;
    const track = trackRef.current!;
    const startY = e.clientY;
    const startScrollTop = el.scrollTop;
    const maxScrollTop = el.scrollHeight - el.clientHeight;
    const maxThumbTop = track.clientHeight - thumbEl.offsetHeight;

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      el.scrollTop = Math.max(0, Math.min(startScrollTop + (dy / maxThumbTop) * maxScrollTop, maxScrollTop));
    };
    const onUp = () => {
      thumbEl.removeEventListener('pointermove', onMove);
      thumbEl.removeEventListener('pointerup', onUp);
    };

    thumbEl.addEventListener('pointermove', onMove);
    thumbEl.addEventListener('pointerup', onUp);
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    const el = scrollRef.current;
    if (!track || !el || !thumb) return;
    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top - thumb.height / 2;
    const ratio = Math.max(0, Math.min(clickY / (track.clientHeight - thumb.height), 1));
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
  };

  if (!thumb) return null;

  return (
    <div className="custom-scrollbar-track" ref={trackRef} onClick={handleTrackClick}>
      <div
        className="custom-scrollbar-thumb"
        style={{ top: `${thumb.top}px`, height: `${thumb.height}px` }}
        onPointerDown={handleThumbPointerDown}
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}

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
  const { artworkUrl } = useArtwork(track.id, `${track.album}||${track.album_artist}`);

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

// Virtual + sortable item.
// Uses `top` for virtual positioning so WebKitGTK reports correct getBoundingClientRect()
// values — stacked CSS transforms confuse WebKit's rect calculation which breaks collision
// detection. The dnd-kit translate is applied on top of `top`, giving correct cursor tracking.
function VirtualSortableQueueItemRow(props: QueueItemRowProps & {
  id: string;
  virtualStart: number;
  virtualSize: number;
  scrollMargin: number;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });

  const style: React.CSSProperties = {
    position: 'absolute',
    top: `${props.virtualStart - props.scrollMargin}px`,
    left: 0,
    width: '100%',
    height: `${props.virtualSize}px`,
    transform: transform ? `translateY(${transform.y}px)` : undefined,
    transition,
    zIndex: isDragging ? 10 : 0,
    opacity: isDragging ? 0.85 : 1,
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

  const previousCount = currentIndex !== null && currentIndex >= 0
    ? currentIndex
    : tracks.length;
  const upNextStart = currentIndex !== null && currentIndex >= 0
    ? currentIndex + 1
    : 0;
  const upNextCount = Math.max(0, tracks.length - upNextStart);

  // Recompute scrollMargin whenever sections above the Up Next list change height
  useLayoutEffect(() => {
    if (!queueContentRef.current || !upNextListRef.current) return;
    const listTop = upNextListRef.current.getBoundingClientRect().top;
    const containerTop = queueContentRef.current.getBoundingClientRect().top;
    setScrollMargin(listTop - containerTop + queueContentRef.current.scrollTop);
  }, [showHistory, currentIndex, upNextCount]);

  const upNextVirtualizer = useVirtualizer({
    count: upNextCount,
    getScrollElement: () => queueContentRef.current,
    estimateSize: () => 52, // 50px item height + 2px gap
    overscan: 8,
    scrollMargin,
  });

  const upNextVirtualItems = upNextVirtualizer.getVirtualItems();
  const sortableItems = upNextVirtualItems
    .map((virtualRow) => {
      const actualIdx = upNextStart + virtualRow.index;
      const track = tracks[actualIdx];
      return track ? `${track.id}-${actualIdx}` : null;
    })
    .filter((id): id is string => id !== null);

  const handleClearAll = async () => { await clearQueue(); };
  const handleClearHistory = async () => { await clearHistory(); };
  const handleClearUpNext = async () => { await clearUpNext(); };

  const handleRemove = async (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    await removeFromQueue(index);
  };

  const handlePlay = async (index: number) => { await playQueueIndex(index); };

  const handleDragEnd = async (event: DragEndEvent) => {
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

      <div className="queue-scroll-wrapper">
      <div className="queue-content" ref={queueContentRef}>
        {previousCount > 0 && (
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
                {Array.from({ length: previousCount }, (_, i) => {
                  const track = tracks[i];
                  if (!track) return null;
                  return (
                    <QueueItemRow
                      key={`prev-${track.id}-${i}`}
                      track={track}
                      onDoubleClick={() => handlePlay(i)}
                      onPlayClick={(e) => { e.stopPropagation(); handlePlay(i); }}
                    />
                  );
                })}
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
            {upNextCount > 0 && (
              <button className="icon-btn--sm" onClick={handleClearUpNext} title="Clear up next">
                <Trash2 size={14} />
              </button>
            )}
          </div>

          {upNextCount === 0 ? (
            <div className="empty-state">
              <p>Queue is empty</p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              autoScroll={false}
            >
              <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
                <div
                  className="queue-list"
                  ref={upNextListRef}
                  style={{ position: 'relative', height: `${upNextVirtualizer.getTotalSize()}px` }}
                >
                  {upNextVirtualItems.map((virtualRow) => {
                    const actualIdx = upNextStart + virtualRow.index;
                    const track = tracks[actualIdx];
                    if (!track) return null;
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
            </DndContext>
          )}
        </div>
      </div>
      <CustomScrollbar scrollRef={queueContentRef} />
      </div>
    </aside>
  );
}

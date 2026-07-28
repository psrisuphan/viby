import {
	X,
	Play,
	GripVertical,
	ChevronDown,
	ChevronRight,
	Trash2,
	Music,
	PanelRight,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useQueueStore } from "../../stores/queueStore";
import { usePlayerStore } from "../../stores/playerStore";
import {
	clearQueue,
	clearUpNext,
	clearHistory,
	removeFromQueue,
	reorderQueue,
	playQueueIndex,
} from "../../utils/tauri";
import { useState, useRef, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useArtwork } from "../../utils/useArtwork";
import type { Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import "./QueuePanel.css";

import {
	DndContext,
	closestCenter,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
	useSortable,
} from "@dnd-kit/sortable";

function EqVisualizer({ isPlaying }: { isPlaying: boolean }) {
	return (
		<div
			className={`eq-visualizer${isPlaying ? " eq-playing" : ""}`}
			aria-hidden
		>
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
	loadArtworkPaused?: boolean;
}

function QueueItemRow({
	track,
	isDragged,
	isActive,
	isPlaying,
	onPlayClick,
	onDoubleClick,
	onRemove,
	showDragHandle,
	dragHandleProps,
	loadArtworkPaused,
}: QueueItemRowProps) {
	const { artworkUrl } = useArtwork(
		track.id,
		`${track.album}||${track.album_artist}`,
		{ paused: loadArtworkPaused, size: 128 },
	);

	return (
		<div
			className={`queue-item ${isDragged ? "is-dragged" : ""} ${isActive ? "active" : ""}`}
			onDoubleClick={onDoubleClick}
		>
			<div className="queue-item-art">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" className="queue-item-art-img" />
				) : (
					<Music size={14} className="text-tertiary" />
				)}
				<button className="queue-item-play-btn" onClick={onPlayClick}>
					<Play size={12} fill="currentColor" style={{ marginLeft: "1px" }} />
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
					<div
						className="drag-handle"
						title="Drag to reorder"
						style={{ cursor: "grab" }}
						{...dragHandleProps}
					>
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
function VirtualSortableQueueItemRow(
	props: QueueItemRowProps & {
		id: string;
		virtualStart: number;
		virtualSize: number;
		scrollMargin: number;
	},
) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: props.id });

	const style: React.CSSProperties = {
		position: "absolute",
		top: `${props.virtualStart - props.scrollMargin}px`,
		left: 0,
		width: "100%",
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
				dragHandleProps={{
					ref: setActivatorNodeRef,
					...attributes,
					...listeners,
				}}
			/>
		</div>
	);
}

export default function QueuePanel({ compact = false }: { compact?: boolean }) {
	const isQueueFloating = useUiStore((state) => state.isQueueFloating);
	const setQueueFloating = useUiStore((state) => state.setQueueFloating);
	const setQueueOpen = useUiStore((s) => s.setQueueOpen);
	const tracks = useQueueStore((s) => s.tracks);
	const currentIndex = useQueueStore((s) => s.currentIndex);
	const isPlaying = usePlayerStore((s) => s.isPlaying);

	const [showHistory, setShowHistory] = useState(false);

	const queueContentRef = useRef<HTMLDivElement>(null);
	const previousListRef = useRef<HTMLDivElement>(null);
	const upNextListRef = useRef<HTMLDivElement>(null);
	const [previousScrollMargin, setPreviousScrollMargin] = useState(0);
	const [scrollMargin, setScrollMargin] = useState(0);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const currentTrack =
		currentIndex !== null && currentIndex >= 0 && currentIndex < tracks.length
			? tracks[currentIndex]
			: null;

	const previousCount =
		currentIndex !== null && currentIndex >= 0 ? currentIndex : tracks.length;
	const upNextStart =
		currentIndex !== null && currentIndex >= 0 ? currentIndex + 1 : tracks.length;
	const upNextCount = Math.max(0, tracks.length - upNextStart);

	useLayoutEffect(() => {
		if (!showHistory) {
			setPreviousScrollMargin(0);
			return;
		}
		if (!queueContentRef.current || !previousListRef.current) return;
		const listTop = previousListRef.current.getBoundingClientRect().top;
		const containerTop = queueContentRef.current.getBoundingClientRect().top;
		setPreviousScrollMargin(
			listTop - containerTop + queueContentRef.current.scrollTop,
		);
	}, [showHistory, previousCount]);

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
		overscan: 4,
		scrollMargin,
	});

	const previousVirtualizer = useVirtualizer({
		count: showHistory ? previousCount : 0,
		getScrollElement: () => queueContentRef.current,
		estimateSize: () => 52, // 50px item height + 2px gap
		overscan: 4,
		scrollMargin: previousScrollMargin,
	});

	const upNextVirtualItems = upNextVirtualizer.getVirtualItems();
	const previousVirtualItems = previousVirtualizer.getVirtualItems();
	const sortableItems = upNextVirtualItems
		.map((virtualRow) => {
			const actualIdx = upNextStart + virtualRow.index;
			const track = tracks[actualIdx];
			return track ? `${track.id}-${actualIdx}` : null;
		})
		.filter((id): id is string => id !== null);

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
			const oldIdxStr = (active.id as string).split("-").pop();
			const newIdxStr = (over.id as string).split("-").pop();
			if (oldIdxStr && newIdxStr) {
				await reorderQueue(parseInt(oldIdxStr, 10), parseInt(newIdxStr, 10));
			}
		}
	};

	return (
		<aside
			className={`queue-panel${compact ? " is-compact" : ` animate-slide-right${isQueueFloating ? " is-floating" : ""}`}`}
		>
			<div className="queue-header">
				<div className="queue-title-group">
					<h2>Play Queue</h2>
					{!compact && (
						<button
							className={`queue-mode-btn${isQueueFloating ? " active" : ""}`}
							onClick={() => setQueueFloating(!isQueueFloating)}
							title={isQueueFloating ? "Dock queue" : "Float queue over content"}
							aria-label={isQueueFloating ? "Dock queue" : "Float queue over content"}
							aria-pressed={isQueueFloating}
						>
							<PanelRight size={15} />
						</button>
					)}
				</div>
				<div className="queue-actions">
					<button
						className="icon-btn--sm queue-clear-btn"
						onClick={handleClearAll}
						title="Clear entire queue"
					>
						<span className="text-xs">Clear All</span>
					</button>
					<button className="icon-btn" onClick={() => setQueueOpen(false)}>
						<X size={20} />
					</button>
				</div>
			</div>

			<div className="queue-scroll-wrapper scrollbar-host">
				<div className="queue-content" ref={queueContentRef}>
					{previousCount > 0 && (
						<div className="queue-section">
							<div
								className="queue-section-title"
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									cursor: "pointer",
									userSelect: "none",
								}}
								onClick={() => setShowHistory(!showHistory)}
							>
								<div
									style={{ display: "flex", alignItems: "center", gap: "8px" }}
								>
									{showHistory ? (
										<ChevronDown size={14} />
									) : (
										<ChevronRight size={14} />
									)}
									<span>Previously Played</span>
								</div>
								<button
									className="icon-btn--sm"
									onClick={(e) => {
										e.stopPropagation();
										handleClearHistory();
									}}
									title="Clear history"
								>
									<Trash2 size={14} />
								</button>
							</div>

							{showHistory && (
								<div
									className="queue-list"
									ref={previousListRef}
									style={{
										opacity: 0.6,
										position: "relative",
										height: `${previousVirtualizer.getTotalSize()}px`,
									}}
								>
									{previousVirtualItems.map((virtualRow) => {
										const i = virtualRow.index;
										const track = tracks[i];
										if (!track) return null;
										return (
											<div
												key={`prev-${track.id}-${i}`}
												style={{
													position: "absolute",
													top: `${virtualRow.start - previousScrollMargin}px`,
													left: 0,
													width: "100%",
													height: `${virtualRow.size}px`,
												}}
											>
												<QueueItemRow
													track={track}
													loadArtworkPaused={previousVirtualizer.isScrolling}
													onDoubleClick={() => handlePlay(i)}
													onPlayClick={(e) => {
														e.stopPropagation();
														handlePlay(i);
													}}
												/>
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}

					{currentTrack && (
						<div className="queue-section">
							<h3 className="queue-section-title">Now Playing</h3>
							<div className="queue-list">
								<QueueItemRow
									track={currentTrack}
									isActive={true}
									isPlaying={isPlaying}
									onDoubleClick={() => handlePlay(currentIndex!)}
									onPlayClick={(e) => {
										e.stopPropagation();
										handlePlay(currentIndex!);
									}}
								/>
							</div>
						</div>
					)}

					<div className="queue-section">
						<div
							className="queue-section-title"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
							}}
						>
							<span>Up Next</span>
							{upNextCount > 0 && (
								<button
									className="icon-btn--sm"
									onClick={handleClearUpNext}
									title="Clear up next"
								>
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
								<SortableContext
									items={sortableItems}
									strategy={verticalListSortingStrategy}
								>
									<div
										className="queue-list"
										ref={upNextListRef}
										style={{
											position: "relative",
											height: `${upNextVirtualizer.getTotalSize()}px`,
										}}
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
													loadArtworkPaused={upNextVirtualizer.isScrolling}
													virtualStart={virtualRow.start}
													virtualSize={virtualRow.size}
													scrollMargin={scrollMargin}
													onDoubleClick={() => handlePlay(actualIdx)}
													onPlayClick={(e) => {
														e.stopPropagation();
														handlePlay(actualIdx);
													}}
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

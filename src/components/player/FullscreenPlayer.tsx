import { useRef, useState, useEffect, useLayoutEffect } from "react";
import {
	X,
	SkipBack,
	SkipForward,
	Shuffle,
	Repeat,
	Volume2,
	VolumeX,
	Music,
	Play,
	ChevronDown,
	Disc3,
	Trash2,
	GripVertical,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { usePlayerStore } from "../../stores/playerStore";
import { useUiStore } from "../../stores/uiStore";
import { useQueueStore } from "../../stores/queueStore";
import { useArtwork } from "../../utils/useArtwork";
import { getPlaybackQualityInfo } from "../../utils/quality";
import { formatTime } from "../../utils/formatTime";
import {
	pausePlayback,
	resumePlayback,
	seekTo,
	setVolume as setRustVolume,
	nextTrack,
	previousTrack,
	setShuffle as setTauriShuffle,
	setRepeat as setTauriRepeat,
	playQueueIndex,
	removeFromQueue,
	reorderQueue,
	clearUpNext,
	clearHistory,
} from "../../utils/tauri";
import type { RepeatMode, Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import "./FullscreenPlayer.css";

const BAR_COUNT = 68;

function AudioVisualizer({
	progress,
	isPlaying,
	onSeek,
	onDragProgress,
}: {
	progress: number;
	isPlaying: boolean;
	onSeek: (pct: number) => void;
	onDragProgress: (pct: number | null) => void;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const bars = useRef(Array.from({ length: BAR_COUNT }, () => 0.05));
	const targets = useRef(
		Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.5),
	);
	const rafRef = useRef(0);
	const dragProgress = useRef<number | null>(null);
	const progressRef = useRef(progress);
	const isPlayingRef = useRef(isPlaying);

	useEffect(() => {
		progressRef.current = progress;
	}, [progress]);
	useEffect(() => {
		isPlayingRef.current = isPlaying;
	}, [isPlaying]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const wrap = wrapRef.current;
		if (!canvas || !wrap) return;
		const ctx = canvas.getContext("2d")!;

		const draw = () => {
			const dpr = window.devicePixelRatio || 1;
			const { width: cssW, height: cssH } = wrap.getBoundingClientRect();

			if (cssW < 10 || cssH < 4) {
				rafRef.current = requestAnimationFrame(draw);
				return;
			}

			const W = Math.round(cssW * dpr);
			const H = Math.round(cssH * dpr);
			if (canvas.width !== W || canvas.height !== H) {
				canvas.width = W;
				canvas.height = H;
				bars.current.fill(0.05);
				targets.current = Array.from(
					{ length: BAR_COUNT },
					() => 0.1 + Math.random() * 0.5,
				);
			}
			ctx.clearRect(0, 0, W, H);

			const accentRgb =
				getComputedStyle(document.documentElement)
					.getPropertyValue("--accent-rgb")
					.trim() || "121, 236, 131";

			const gap = Math.round(2.5 * dpr);
			const barW = Math.max(1, (W - gap * (BAR_COUNT - 1)) / BAR_COUNT);
			const displayProgress = dragProgress.current ?? progressRef.current;

			bars.current.forEach((h, i) => {
				if (isPlayingRef.current) {
					bars.current[i] += (targets.current[i] - h) * 0.12;
					if (Math.abs(bars.current[i] - targets.current[i]) < 0.02) {
						targets.current[i] = 0.1 + Math.random() * 0.9;
					}
				}

				const isPast = i / BAR_COUNT < displayProgress;
				const barH = Math.max(Math.round(3 * dpr), bars.current[i] * H * 0.85);
				const x = i * (barW + gap);
				const y = (H - barH) / 2;

				ctx.fillStyle = isPast
					? `rgba(${accentRgb}, 0.95)`
					: "hsla(0, 0%, 100%, 0.22)";

				ctx.beginPath();
				const r = Math.min(barW / 2, 2 * dpr);
				ctx.roundRect(x, y, barW, barH, r);
				ctx.fill();
			});

			rafRef.current = requestAnimationFrame(draw);
		};

		rafRef.current = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(rafRef.current);
	}, []);

	const pctFromX = (clientX: number) => {
		const wrap = wrapRef.current;
		if (!wrap) return 0;
		const rect = wrap.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	};

	const pctFromEvent = (e: React.MouseEvent | MouseEvent) => {
		return pctFromX(e.clientX);
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		const pct = pctFromEvent(e);
		dragProgress.current = pct;
		onDragProgress(pct);
		const onMove = (ev: MouseEvent) => {
			const p = pctFromEvent(ev);
			dragProgress.current = p;
			onDragProgress(p);
		};
		const onUp = (ev: MouseEvent) => {
			onSeek(pctFromEvent(ev));
			setTimeout(() => {
				dragProgress.current = null;
				onDragProgress(null);
			}, 300);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const handleTouchStart = (e: React.TouchEvent) => {
		if (e.touches.length === 0) return;
		e.preventDefault();
		const touch = e.touches[0];
		const pct = pctFromX(touch.clientX);
		dragProgress.current = pct;
		onDragProgress(pct);
		
		const onTouchMove = (ev: TouchEvent) => {
			if (ev.touches.length === 0) return;
			const p = pctFromX(ev.touches[0].clientX);
			dragProgress.current = p;
			onDragProgress(p);
		};
		
		const onTouchEnd = (ev: TouchEvent) => {
			const endTouch = ev.changedTouches[0] || ev.touches[0];
			if (endTouch) {
				onSeek(pctFromX(endTouch.clientX));
			}
			setTimeout(() => {
				dragProgress.current = null;
				onDragProgress(null);
			}, 300);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("touchend", onTouchEnd);
		};
		
		window.addEventListener("touchmove", onTouchMove, { passive: false });
		window.addEventListener("touchend", onTouchEnd);
	};

	return (
		<div 
			ref={wrapRef} 
			className="fs-vis-wrap" 
			onMouseDown={handleMouseDown}
			onTouchStart={handleTouchStart}
		>
			<canvas ref={canvasRef} className="fs-visualizer" />
		</div>
	);
}

// ─── Queue item ───────────────────────────────────────────────────────────────

function FullscreenQueueItem({
	track,
	isActive,
	isPlaying,
	onPlay,
	onRemove,
	dragHandleProps,
}: {
	track: Track;
	isActive?: boolean;
	isPlaying?: boolean;
	onPlay: () => void;
	onRemove?: () => void;
	dragHandleProps?: Record<string, any>;
}) {
	const { artworkUrl } = useArtwork(
		track.id,
		`${track.album}||${track.album_artist}`,
	);

	return (
		<div
			className={`fs-queue-item${isActive ? " active" : ""}`}
			onDoubleClick={onPlay}
		>
			<div className="fs-queue-art">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" />
				) : (
					<Music size={13} className="text-tertiary" />
				)}
				<button className="fs-queue-play-btn" onClick={onPlay}>
					<Play size={11} fill="currentColor" style={{ marginLeft: 1 }} />
				</button>
			</div>
			<div className="fs-queue-info">
				<div className="fs-queue-title truncate">{track.title}</div>
				<div className="fs-queue-artist truncate">{track.artist}</div>
			</div>
			{isActive && (
				<div className={`fs-eq${isPlaying ? " playing" : ""}`} aria-hidden>
					<span />
					<span />
					<span />
					<span />
				</div>
			)}
			{!isActive && (
				<div className="fs-queue-item-actions">
					{dragHandleProps && (
						<div className="fs-drag-handle" {...dragHandleProps}>
							<GripVertical size={14} />
						</div>
					)}
					{onRemove && (
						<button
							className="fs-queue-remove"
							onClick={(e) => {
								e.stopPropagation();
								onRemove();
							}}
						>
							<X size={13} />
						</button>
					)}
				</div>
			)}
		</div>
	);
}

// Virtual + sortable wrapper — same pattern as QueuePanel.
// When this item is being dragged, it becomes an invisible placeholder; DragOverlay shows the copy.
function VirtualSortableFsQueueItem(props: {
	id: string;
	track: Track;
	virtualStart: number;
	virtualSize: number;
	scrollMargin: number;
	onPlay: () => void;
	onRemove: () => void;
}) {
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
			<FullscreenQueueItem
				track={props.track}
				onPlay={props.onPlay}
				onRemove={props.onRemove}
				dragHandleProps={{
					ref: setActivatorNodeRef,
					...attributes,
					...listeners,
				}}
			/>
		</div>
	);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FullscreenPlayer() {
	const { setTheaterMode } = useUiStore();

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const {
		isPlaying,
		currentTrack,
		positionSecs,
		durationSecs,
		volume,
		isMuted,
		shuffle,
		repeatMode,
		sampleRate,
		bitsPerSample,
		audioPath,
		setIsPlaying,
		toggleMute,
		setVolume,
		toggleShuffle,
		cycleRepeat,
	} = usePlayerStore();
	const { tracks, currentIndex } = useQueueStore();
	const { artworkUrl } = useArtwork(
		currentTrack?.id || null,
		currentTrack
			? `${currentTrack.album}||${currentTrack.album_artist}`
			: undefined,
	);
	const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);

	// ── Seek ──
	const [dragPct, setDragPct] = useState<number | null>(null);

	// ── Volume ──
	const volumeRef = useRef<HTMLDivElement>(null);
	const applyVolume = async (clientX: number) => {
		if (!volumeRef.current) return;
		const rect = volumeRef.current.getBoundingClientRect();
		const vol = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
		setVolume(vol);
		await setRustVolume(vol);
	};

	const handleVolumeDown = (e: React.MouseEvent<HTMLDivElement>) => {
		applyVolume(e.clientX);
		const onMove = (mv: MouseEvent) => applyVolume(mv.clientX);
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	const handleVolumeTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
		if (e.touches.length === 0) return;
		e.preventDefault();
		const touch = e.touches[0];
		applyVolume(touch.clientX);
		
		const onTouchMove = (mv: TouchEvent) => {
			if (mv.touches.length === 0) return;
			applyVolume(mv.touches[0].clientX);
		};
		const onTouchEnd = () => {
			document.removeEventListener("touchmove", onTouchMove);
			document.removeEventListener("touchend", onTouchEnd);
		};
		document.addEventListener("touchmove", onTouchMove, { passive: false });
		document.addEventListener("touchend", onTouchEnd);
	};

	// ── Controls ──
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

	const handleMute = async () => {
		const { isMuted, previousVolume } = usePlayerStore.getState();
		toggleMute();
		await setRustVolume(isMuted ? previousVolume || 1 : 0);
	};

	const handleShuffle = async () => {
		toggleShuffle();
		await setTauriShuffle(!shuffle);
	};

	const handleRepeat = async () => {
		const modes: RepeatMode[] = ["off", "all", "one"];
		cycleRepeat();
		await setTauriRepeat(modes[(modes.indexOf(repeatMode) + 1) % modes.length]);
	};

	// ── Close on Escape ──
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setTheaterMode(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setTheaterMode]);

	const previousCount =
		currentIndex !== null && currentIndex >= 0 ? currentIndex : tracks.length;
	const upNextStart =
		currentIndex !== null && currentIndex >= 0 ? currentIndex + 1 : tracks.length;
	const upNextCount = Math.max(0, tracks.length - upNextStart);

	const [showHistory, setShowHistory] = useState(false);

	const handleDragEnd = async (event: DragEndEvent) => {
		const { active, over } = event;
		if (over && active.id !== over.id) {
			const oldIdx = parseInt((active.id as string).split("-").pop()!, 10);
			const newIdx = parseInt((over.id as string).split("-").pop()!, 10);
			await reorderQueue(oldIdx, newIdx);
		}
	};
	const queueScrollRef = useRef<HTMLDivElement>(null);
	const upNextListRef = useRef<HTMLDivElement>(null);
	const [queueScrollMargin, setQueueScrollMargin] = useState(0);

	useLayoutEffect(() => {
		if (!queueScrollRef.current || !upNextListRef.current) return;
		const listTop = upNextListRef.current.getBoundingClientRect().top;
		const containerTop = queueScrollRef.current.getBoundingClientRect().top;
		setQueueScrollMargin(
			listTop - containerTop + queueScrollRef.current.scrollTop,
		);
	}, [showHistory, currentIndex, upNextCount]);

	const upNextVirtualizer = useVirtualizer({
		count: upNextCount,
		getScrollElement: () => queueScrollRef.current,
		estimateSize: () => 52,
		overscan: 8,
		scrollMargin: queueScrollMargin,
	});
	const upNextVirtualItems = upNextVirtualizer.getVirtualItems();
	const sortableItems = upNextVirtualItems
		.map((virtualRow) => {
			const actualIdx = upNextStart + virtualRow.index;
			const track = tracks[actualIdx];
			return track ? `${track.id}-${actualIdx}` : null;
		})
		.filter((id): id is string => id !== null);

	// ── Derived display values ──
	const displayTime = dragPct !== null ? dragPct * durationSecs : positionSecs;
	const remainingTime = Math.max(0, durationSecs - displayTime);
	const volPct = isMuted ? 0 : volume * 100;

	return (
		<div className="fs-player animate-fade-in" data-tauri-drag-region>
			{/* Blurred desktop + artwork colour wash */}
			<div className="fs-backdrop" data-tauri-drag-region>
				{artworkUrl && (
					<img src={artworkUrl} alt="" className="fs-backdrop-img" />
				)}
				<div className="fs-backdrop-overlay" data-tauri-drag-region />
			</div>

			{/* Close button */}
			<button
				className="fs-close-btn"
				onClick={() => setTheaterMode(false)}
				title="Exit fullscreen (Esc)"
				data-tauri-no-drag
			>
				<ChevronDown size={22} />
			</button>

			{/* Content */}
			<div className="fs-content" data-tauri-drag-region>
				{/* ── Left: artwork + controls ── */}
				<div className="fs-left" data-tauri-drag-region>
					<div className="fs-artwork-wrap" data-tauri-drag-region>
						{artworkUrl ? (
							<img
								src={artworkUrl}
								alt={currentTrack?.title}
								className={`fs-artwork${isPlaying ? " playing" : ""}`}
							/>
						) : (
							<div className="fs-artwork-placeholder" data-tauri-drag-region>
								<Music size={80} />
							</div>
						)}
					</div>

					<div className="fs-track-info" data-tauri-drag-region>
						<div className="fs-track-title truncate" data-tauri-drag-region>
							{currentTrack?.title ?? "—"}
						</div>
						<div className="fs-track-artist truncate" data-tauri-drag-region>
							{currentTrack
								? `${currentTrack.artist}${currentTrack.album ? ` · ${currentTrack.album}` : ""}`
								: "No track playing"}
						</div>
						{qualityInfo && (
							<div
								className="fs-playback-quality-info"
								title={`${qualityInfo.badge} quality details: ${qualityInfo.specs}`}
								data-tauri-drag-region
							>
								<span
									className={`quality-badge ${qualityInfo.isHiRes ? "hi-res" : qualityInfo.isLossless ? "lossless" : "hq"}`}
								>
									{qualityInfo.badge}
								</span>
								<span className="quality-specs" data-tauri-drag-region>
									{qualityInfo.specs}
								</span>
							</div>
						)}
					</div>

					{/* Progress */}
					<div className="fs-progress-wrap" data-tauri-no-drag>
						<span className="fs-time">{formatTime(displayTime)}</span>
						<AudioVisualizer
							progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
							isPlaying={isPlaying}
							onSeek={(pct) => seekTo(pct * durationSecs)}
							onDragProgress={setDragPct}
						/>
						<span className="fs-time">-{formatTime(remainingTime)}</span>
					</div>

					{/* Playback controls */}
					<div className="fs-controls" data-tauri-no-drag>
						<button
							className={`fs-ctrl-btn${shuffle ? " active" : ""}`}
							onClick={handleShuffle}
							title="Shuffle"
						>
							<Shuffle size={20} />
						</button>
						<button
							className="fs-ctrl-btn"
							title="Previous"
							onClick={async () => {
								positionSecs > 3 ? await seekTo(0) : await previousTrack(true);
							}}
						>
							<SkipBack size={24} />
						</button>
						<button
							className="fs-play-btn"
							onClick={handlePlayPause}
							disabled={!currentTrack}
						>
							<Disc3
								size={36}
								strokeWidth={1.5}
								className={`vinyl-icon${isPlaying ? " is-playing" : ""}`}
							/>
						</button>
						<button
							className="fs-ctrl-btn"
							title="Next"
							onClick={() => nextTrack(true)}
						>
							<SkipForward size={24} />
						</button>
						<button
							className={`fs-ctrl-btn${repeatMode !== "off" ? " active" : ""}`}
							onClick={handleRepeat}
							title={`Repeat: ${repeatMode}`}
						>
							<Repeat size={20} />
							{repeatMode === "one" && (
								<span className="fs-repeat-badge">1</span>
							)}
						</button>
					</div>

					{/* Volume */}
					<div className="fs-volume" data-tauri-no-drag>
						<button className="fs-ctrl-btn" onClick={handleMute}>
							{isMuted || volume === 0 ? (
								<VolumeX size={18} />
							) : (
								<Volume2 size={18} />
							)}
						</button>
						<div
							className="fs-vol-slider"
							ref={volumeRef}
							onMouseDown={handleVolumeDown}
							onTouchStart={handleVolumeTouchStart}
						>
							<div className="fs-vol-bg">
								<div className="fs-vol-fill" style={{ width: `${volPct}%` }} />
								<div className="fs-vol-thumb" style={{ left: `${volPct}%` }} />
							</div>
						</div>
					</div>
				</div>

				{/* ── Right: queue ── */}
				<div className="fs-queue" data-tauri-no-drag>
					<div className="fs-queue-header">
						<span>Play Queue</span>
					</div>

					<div className="fs-queue-scroll-wrapper scrollbar-host">
						<div className="fs-queue-scroll" ref={queueScrollRef}>
							{/* Previously Played */}
							{previousCount > 0 && (
								<div className="fs-queue-section">
									<div
										className="fs-queue-section-label clickable"
										onClick={() => setShowHistory((h) => !h)}
									>
										<span>
											{showHistory ? "▾" : "▸"} Previously Played (
											{previousCount})
										</span>
										<button
											className="fs-queue-action-btn"
											onClick={(e) => {
												e.stopPropagation();
												clearHistory();
											}}
											title="Clear history"
										>
											<Trash2 size={13} />
										</button>
									</div>
									{showHistory && (
										<div style={{ opacity: 0.55 }}>
											{Array.from({ length: previousCount }, (_, i) => {
												const track = tracks[i];
												if (!track) return null;
												return (
													<FullscreenQueueItem
														key={`prev-${track.id}-${i}`}
														track={track}
														onPlay={() => playQueueIndex(i)}
													/>
												);
											})}
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
									{upNextCount > 0 && (
										<button
											className="fs-queue-action-btn"
											onClick={() => clearUpNext()}
											title="Clear up next"
										>
											<Trash2 size={13} />
										</button>
									)}
								</div>
								{upNextCount === 0 ? (
									<div className="fs-queue-empty">Nothing up next</div>
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
												ref={upNextListRef}
												style={{
													position: "relative",
													height: `${upNextVirtualizer.getTotalSize()}px`,
												}}
											>
												{upNextVirtualItems.map((vRow) => {
													const actualIdx = upNextStart + vRow.index;
													const track = tracks[actualIdx];
													if (!track) return null;
													const id = `${track.id}-${actualIdx}`;
													return (
														<VirtualSortableFsQueueItem
															key={id}
															id={id}
															track={track}
															virtualStart={vRow.start}
															virtualSize={vRow.size}
															scrollMargin={queueScrollMargin}
															onPlay={() => playQueueIndex(actualIdx)}
															onRemove={() => removeFromQueue(actualIdx)}
														/>
													);
												})}
											</div>
										</SortableContext>
									</DndContext>
								)}
							</div>
						</div>
						<CustomScrollbar scrollRef={queueScrollRef} />
					</div>
				</div>
			</div>
		</div>
	);
}

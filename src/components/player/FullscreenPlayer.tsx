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
import { useSettingsStore } from "../../stores/settingsStore";
import { useQueueStore } from "../../stores/queueStore";
import { useArtwork } from "../../utils/useArtwork";
import { getPlaybackQualityInfo } from "../../utils/quality";
import { usePrefersReducedMotion } from "../../utils/usePrefersReducedMotion";
import { useWindowActive } from "../../utils/useWindowActive";
import { formatTime } from "../../utils/formatTime";
import { notifyActionFailure, runActionWithFeedback } from "../../utils/actionFeedback";
import { isModalDialogOpen } from "../ui/dialogManager";
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
	leaveTheaterMode,
} from "../../utils/tauri";
import type { RepeatMode, Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import AccessibleSlider from "../ui/AccessibleSlider";
import "./FullscreenPlayer.css";

const BAR_COUNT = 68;
const VISUALIZER_FRAME_INTERVAL_MS = 1000 / 30;

function AudioVisualizer({
	progress,
	durationSecs,
	isPlaying,
	onSeek,
	onDragProgress,
	simple = false,
}: {
	progress: number;
	durationSecs: number;
	isPlaying: boolean;
	onSeek: (pct: number) => void;
	onDragProgress: (pct: number | null) => void;
	simple?: boolean;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const bars = useRef(Array.from({ length: BAR_COUNT }, () => 0.05));
	const targets = useRef(
		Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.5),
	);
	const timerRef = useRef(0);
	const scheduleDrawRef = useRef<(() => void) | null>(null);
	const dragProgress = useRef<number | null>(null);
	const progressRef = useRef(progress);
	const isPlayingRef = useRef(isPlaying);
	const dimensionsRef = useRef({ width: 0, height: 0 });
	const accentColorRef = useRef("121, 236, 131");

	useEffect(() => {
		progressRef.current = progress;
		scheduleDrawRef.current?.();
	}, [progress]);
	useEffect(() => {
		isPlayingRef.current = isPlaying;
		scheduleDrawRef.current?.();
	}, [isPlaying]);
	useEffect(() => {
		const canvas = canvasRef.current;
		const wrap = wrapRef.current;
		if (!canvas || !wrap) return;
		const ctx = canvas.getContext("2d")!;
		const initialRect = wrap.getBoundingClientRect();
		dimensionsRef.current = { width: initialRect.width, height: initialRect.height };

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				dimensionsRef.current = { width, height };
			}
			scheduleDrawRef.current?.();
		});
		observer.observe(wrap);

		const updateAccentColor = () => {
			const color = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim();
			if (color) accentColorRef.current = color;
		};
		updateAccentColor();

		const mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
					updateAccentColor();
				}
			}
		});
		mutationObserver.observe(document.documentElement, { attributes: true });

		const draw = () => {
			timerRef.current = 0;
			const dpr = window.devicePixelRatio || 1;
			const { width: cssW, height: cssH } = dimensionsRef.current;

			if (cssW < 10 || cssH < 4) {
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

			const accentRgb = accentColorRef.current;

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

			if (isPlayingRef.current) scheduleDraw();
		};

		const scheduleDraw = () => {
			if (timerRef.current !== 0) return;
			timerRef.current = window.setTimeout(draw, VISUALIZER_FRAME_INTERVAL_MS);
		};
		scheduleDrawRef.current = scheduleDraw;
		draw();
		return () => {
			if (timerRef.current !== 0) window.clearTimeout(timerRef.current);
			scheduleDrawRef.current = null;
			observer.disconnect();
			mutationObserver.disconnect();
		};
	}, []);

	const handleProgressChange = (seconds: number) => {
		if (durationSecs <= 0) return;
		const pct = Math.max(0, Math.min(1, seconds / durationSecs));
		dragProgress.current = pct;
		onDragProgress(pct);
		scheduleDrawRef.current?.();
	};

	const handleProgressCommit = (seconds: number) => {
		if (durationSecs <= 0) return;
		onSeek(Math.max(0, Math.min(1, seconds / durationSecs)));
		setTimeout(() => {
			dragProgress.current = null;
			onDragProgress(null);
			scheduleDrawRef.current?.();
		}, 300);
	};

	const handleProgressCancel = () => {
		dragProgress.current = null;
		onDragProgress(null);
		scheduleDrawRef.current?.();
	};

	return (
		<AccessibleSlider
			ref={wrapRef}
			className="fs-vis-wrap"
			value={Math.max(0, Math.min(durationSecs, progress * durationSecs))}
			min={0}
			max={durationSecs}
			step={1}
			pageStep={30}
			ariaLabel="Playback position"
			ariaValueText={`${formatTime(progress * durationSecs)} of ${formatTime(durationSecs)}`}
			disabled={durationSecs <= 0}
			getHoverValueText={formatTime}
			onValueChange={handleProgressChange}
			onValueCommit={handleProgressCommit}
			onValueCancel={handleProgressCancel}
		>
			{simple ? (
				<div className="simple-playback-progress">
					<span style={{ transform: `scaleX(${progress})` }} />
				</div>
			) : (
				<canvas ref={canvasRef} className="fs-visualizer" />
			)}
		</AccessibleSlider>
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
		{ size: 128 },
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
				<button
					className="fs-queue-play-btn"
					onClick={onPlay}
					aria-label={`Play ${track.title}`}
				>
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
							aria-label={`Remove ${track.title} from queue`}
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

interface FullscreenPlayerProps {
	onExit?: () => void;
}

export default function FullscreenPlayer({ onExit }: FullscreenPlayerProps = {}) {

	const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 5 } });
	const touchSensor = useSensor(TouchSensor);
	const keyboardSensor = useSensor(KeyboardSensor, {
		coordinateGetter: sortableKeyboardCoordinates,
	});
	const sensors = useSensors(mouseSensor, touchSensor, keyboardSensor);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const positionSecs = usePlayerStore((s) => s.positionSecs);
	const durationSecs = usePlayerStore((s) => s.durationSecs);
	const volume = usePlayerStore((s) => s.volume);
	const isMuted = usePlayerStore((s) => s.isMuted);
	const shuffle = usePlayerStore((s) => s.shuffle);
	const repeatMode = usePlayerStore((s) => s.repeatMode);
	const sampleRate = usePlayerStore((s) => s.sampleRate);
	const bitsPerSample = usePlayerStore((s) => s.bitsPerSample);
	const audioPath = usePlayerStore((s) => s.audioPath);
	const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
	const toggleMute = usePlayerStore((s) => s.toggleMute);
	const setVolume = usePlayerStore((s) => s.setVolume);
	const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
	const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
	const tracks = useQueueStore((s) => s.tracks);
	const currentIndex = useQueueStore((s) => s.currentIndex);
	const reduceVisualEffects = useSettingsStore((s) => s.reduceVisualEffects);
	const prefersReducedMotion = usePrefersReducedMotion();
	const windowActive = useWindowActive();

	const { artworkUrl } = useArtwork(
		currentTrack?.id || null,
		currentTrack
			? `${currentTrack.album}||${currentTrack.album_artist}`
			: undefined,
		{ size: 768 },
	);
	const qualityInfo = getPlaybackQualityInfo(sampleRate, bitsPerSample, audioPath);

	// ── Seek ──
	const [dragPct, setDragPct] = useState<number | null>(null);

	// ── Volume ──
	const [dragVolume, setDragVolume] = useState<number | null>(null);
	const dragVolumeRef = useRef<number | null>(null);
	const volumeRafRef = useRef<number | null>(null);
	const volumeFailureShownRef = useRef(false);

	const setVisualDragVolume = (vol: number) => {
		dragVolumeRef.current = vol;
		if (volumeRafRef.current !== null) return;
		volumeRafRef.current = requestAnimationFrame(() => {
			volumeRafRef.current = null;
			setDragVolume(dragVolumeRef.current);
		});
	};

	const persistVolume = (value: number, options?: { immediate?: boolean }) => {
		void setRustVolume(value, options).catch((error) => {
			if (volumeFailureShownRef.current) return;
			volumeFailureShownRef.current = true;
			notifyActionFailure(error, "Could not change volume.");
			setTimeout(() => { volumeFailureShownRef.current = false; }, 1500);
		});
	};

	const handleVolumeChange = (vol: number) => {
		setVisualDragVolume(vol);
		persistVolume(vol);
	};

	const handleVolumeCommit = (finalVolume: number) => {
		setVolume(finalVolume);
		persistVolume(finalVolume, { immediate: true });
		if (volumeRafRef.current !== null) {
			cancelAnimationFrame(volumeRafRef.current);
			volumeRafRef.current = null;
		}
		dragVolumeRef.current = null;
		setDragVolume(null);
	};

	useEffect(() => {
		return () => {
			if (volumeRafRef.current !== null) {
				cancelAnimationFrame(volumeRafRef.current);
			}
		};
	}, []);

	// ── Controls ──
	const handlePlayPause = () => runActionWithFeedback(async () => {
		if (!currentTrack) return;
		if (isPlaying) {
			setIsPlaying(false);
			await pausePlayback();
		} else {
			setIsPlaying(true);
			await resumePlayback();
		}
	}, { failureMessage: "Could not change playback state." });

	const handleMute = () => runActionWithFeedback(async () => {
		const { isMuted, previousVolume } = usePlayerStore.getState();
		toggleMute();
		await setRustVolume(isMuted ? previousVolume || 1 : 0, { immediate: true });
	}, { failureMessage: "Could not change volume." });

	const handleShuffle = () => runActionWithFeedback(async () => {
		toggleShuffle();
		await setTauriShuffle(!shuffle);
	}, { failureMessage: "Could not change shuffle mode." });

	const handleRepeat = () => runActionWithFeedback(async () => {
		const modes: RepeatMode[] = ["off", "all", "one"];
		cycleRepeat();
		await setTauriRepeat(modes[(modes.indexOf(repeatMode) + 1) % modes.length]);
	}, { failureMessage: "Could not change repeat mode." });

	// ── Close on Escape ──
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented && !isModalDialogOpen()) {
				if (onExit) onExit();
				else void runActionWithFeedback(() => leaveTheaterMode(), {
					failureMessage: "Could not exit theater mode.",
				});
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onExit]);

	const previousCount =
		currentIndex !== null && currentIndex >= 0 ? currentIndex : tracks.length;
	const upNextStart =
		currentIndex !== null && currentIndex >= 0 ? currentIndex + 1 : tracks.length;
	const upNextCount = Math.max(0, tracks.length - upNextStart);

	const [showHistory, setShowHistory] = useState(false);

	const handlePlayQueueIndex = (index: number) =>
		void runActionWithFeedback(() => playQueueIndex(index), {
			failureMessage: "Couldn't play this queued track.",
		});
	const handleRemoveQueueIndex = (index: number) =>
		void runActionWithFeedback(() => removeFromQueue(index), {
			failureMessage: "Couldn't remove this track from the queue.",
		});
	const handleClearQueueHistory = () =>
		void runActionWithFeedback(() => clearHistory(), {
			failureMessage: "Couldn't clear play history.",
		});
	const handleClearQueueUpNext = () =>
		void runActionWithFeedback(() => clearUpNext(), {
			failureMessage: "Couldn't clear upcoming tracks.",
		});

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (over && active.id !== over.id) {
			const oldIdx = parseInt((active.id as string).split("-").pop()!, 10);
			const newIdx = parseInt((over.id as string).split("-").pop()!, 10);
			void runActionWithFeedback(() => reorderQueue(oldIdx, newIdx), {
				failureMessage: "Could not reorder the queue.",
			});
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
		overscan: 4,
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
	const displayVolume = dragVolume ?? (isMuted ? 0 : volume);
	const volPct = displayVolume * 100;

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
				onClick={() => {
					if (onExit) onExit();
					else void runActionWithFeedback(() => leaveTheaterMode(), {
						failureMessage: "Could not exit theater mode.",
					});
				}}
				title="Exit fullscreen (Esc)"
				aria-label="Exit fullscreen"
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
							progress={durationSecs > 0 ? (dragPct ?? positionSecs / durationSecs) : 0}
							durationSecs={durationSecs}
							isPlaying={isPlaying && windowActive && !prefersReducedMotion && !reduceVisualEffects}
							onSeek={(pct) => {
								void runActionWithFeedback(() => seekTo(pct * durationSecs), {
									failureMessage: "Could not seek to that position.",
								});
							}}
							onDragProgress={setDragPct}
							simple={reduceVisualEffects}
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
							onClick={() => {
								void runActionWithFeedback(async () => {
									if (positionSecs > 3) await seekTo(0);
									else await previousTrack(true);
								}, { failureMessage: "Could not go to the previous track." });
							}}
						>
							<SkipBack size={24} />
						</button>
						<button
							className="fs-play-btn"
							onClick={handlePlayPause}
							disabled={!currentTrack}
							aria-label={isPlaying ? "Pause" : "Play"}
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
							onClick={() => {
								void runActionWithFeedback(() => nextTrack(true), {
									failureMessage: "Could not go to the next track.",
								});
							}}
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
						<button
							className="fs-ctrl-btn"
							onClick={handleMute}
							aria-label={displayVolume === 0 ? "Unmute" : "Mute"}
						>
							{displayVolume === 0 ? (
								<VolumeX size={18} />
							) : (
								<Volume2 size={18} />
							)}
						</button>
						<AccessibleSlider
							className="fs-vol-slider"
							value={displayVolume}
							min={0}
							max={1}
							step={0.01}
							pageStep={0.1}
							ariaLabel="Fullscreen volume"
							ariaValueText={`${Math.round(displayVolume * 100)} percent`}
							onValueChange={handleVolumeChange}
							onValueCommit={handleVolumeCommit}
							onValueCancel={handleVolumeCommit}
						>
							<div className="fs-vol-bg">
								<div className="fs-vol-fill" style={{ width: `${volPct}%` }} />
								<div className="fs-vol-thumb" style={{ left: `${volPct}%` }} />
							</div>
						</AccessibleSlider>
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
								handleClearQueueHistory();
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
									onPlay={() => handlePlayQueueIndex(i)}
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
								onPlay={() => handlePlayQueueIndex(currentIndex)}
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
							onClick={handleClearQueueUpNext}
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
															onPlay={() => handlePlayQueueIndex(actualIdx)}
															onRemove={() => handleRemoveQueueIndex(actualIdx)}
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

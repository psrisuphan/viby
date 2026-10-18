import { useMemo, useRef, useState, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Play, ListPlus, Info, X } from "lucide-react";
import type { Track } from "../../types";
import { formatTime } from "../../utils/formatTime";
import { usePlayerStore } from "../../stores/playerStore";
import { useToastStore } from "../../stores/toastStore";
import {
	addTracksToQueue,
	addToQueue,
	addToQueueNext,
	playTrack,
} from "../../utils/tauri";
import { runActionWithFeedback } from "../../utils/actionFeedback";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import { memo } from "react";
import { useArtwork } from "../../utils/useArtwork";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import AddToPlaylistModal from "../playlist/AddToPlaylistModal";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import { Disc } from "lucide-react";
import { findTrackAlbum } from "../../utils/findTrackAlbum";
import {
	getSongRowKeyAction,
	getSelectedTracksInVisibleOrder,
	updateSongSelection,
	type SelectionModifiers,
} from "./songSelection";
import "./SongTable.css";

interface SongTableProps {
	tracks: Track[];
	hideAlbumColumn?: boolean;
	hideArtwork?: boolean;
	compact?: boolean;
	scrollRef?: React.RefObject<HTMLElement | null>;
}

interface SongRowProps {
	track: Track;
	isCurrent: boolean;
	isPlaying: boolean;
	virtualRow: any;
	totalTracks: number;
	scrollMargin: number;
	hideAlbumColumn?: boolean;
	hideArtwork?: boolean;
	loadArtworkPaused?: boolean;
	onPlay: (track: Track) => void;
	onContextMenu: (e: React.MouseEvent, track: Track) => void;
	onSelect: (
		track: Track,
		index: number,
		checked: boolean,
		modifiers: SelectionModifiers,
	) => void;
	onMoveFocus: (index: number) => void;
	onFocusRow: (index: number) => void;
	onBlurRow: (relatedTarget: EventTarget | null) => void;
	selected: boolean;
	focused: boolean;
	onAlbumClick?: (track: Track) => void;
	onArtistClick?: (track: Track) => void;
}

const SongRow = memo(
	({
		track,
		isCurrent,
		isPlaying,
		virtualRow,
		totalTracks,
		scrollMargin,
		hideAlbumColumn,
		hideArtwork,
		loadArtworkPaused,
		onPlay,
		onContextMenu,
		onSelect,
		onMoveFocus,
		onFocusRow,
		onBlurRow,
		selected,
		focused,
		onAlbumClick,
		onArtistClick,
	}: SongRowProps) => {
		const { artworkUrl } = useArtwork(
			!hideArtwork ? track.id : null,
			!hideArtwork ? `${track.album}||${track.album_artist}` : undefined,
			{ paused: loadArtworkPaused, size: 128 },
		);

		return (
			<div
				className={`song-row ${isCurrent ? "active" : ""}${selected ? " selected" : ""}`}
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: `${virtualRow.size}px`,
					transform: `translateY(${virtualRow.start - scrollMargin}px)`,
				}}
				data-song-index={virtualRow.index}
				role="listitem"
				aria-posinset={virtualRow.index + 1}
				aria-setsize={totalTracks}
				tabIndex={focused ? 0 : -1}
				onFocus={() => onFocusRow(virtualRow.index)}
				onBlur={(event) => onBlurRow(event.relatedTarget)}
				onKeyDown={(event) => {
					const action = getSongRowKeyAction(
						event.key,
						event.target === event.currentTarget,
						virtualRow.index,
						selected,
						{
							shiftKey: event.shiftKey,
							ctrlKey: event.ctrlKey,
							metaKey: event.metaKey,
							altKey: event.altKey,
						},
					);
					if (!action) return;
					event.preventDefault();
					if (action.type === "move-focus") onMoveFocus(action.index);
					if (action.type === "play") onPlay(track);
					if (action.type === "select") {
						onSelect(track, virtualRow.index, action.checked, action.modifiers);
					}
				}}
				onDoubleClick={() => onPlay(track)}
				onContextMenu={(e) => onContextMenu(e, track)}
			>
				<div className="col-play">
					<span className="track-number">
						{track.track_number || virtualRow.index + 1}
					</span>
					<button
						className="row-play-btn"
						onClick={() => onPlay(track)}
						aria-label={`Play ${track.title}`}
					>
						<Play size={16} fill="currentColor" />
					</button>
					{isCurrent && isPlaying && (
						<div className="playing-indicator">
							<div className="eq-bar" />
							<div className="eq-bar" />
							<div className="eq-bar" />
						</div>
					)}
				</div>
				<div className="col-title truncate" title={track.title}>
					<input
						type="checkbox"
						className="song-select-checkbox"
						checked={selected}
						aria-label={`Select ${track.title}`}
						onChange={(event) => {
							const nativeEvent = event.nativeEvent as MouseEvent;
							onSelect(track, virtualRow.index, event.currentTarget.checked, {
								shiftKey: nativeEvent.shiftKey,
								ctrlKey: nativeEvent.ctrlKey,
								metaKey: nativeEvent.metaKey,
								altKey: nativeEvent.altKey,
							});
						}}
						onKeyDown={(event) => {
							if (event.key === " " && event.shiftKey) {
								event.preventDefault();
								onSelect(track, virtualRow.index, true, {
									shiftKey: true,
									ctrlKey: event.ctrlKey,
									metaKey: event.metaKey,
									altKey: event.altKey,
								});
							}
						}}
					/>
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
				<button
					type="button"
					className="col-artist truncate clickable song-row-navigation"
					title={track.artist}
					aria-label={`Go to artist ${track.artist}`}
					onClick={(e) => {
						if (onArtistClick) {
							e.stopPropagation();
							onArtistClick(track);
						}
					}}
				>
					{track.artist}
				</button>
				{!hideAlbumColumn && (
					<button
						type="button"
						className="col-album truncate clickable song-row-navigation"
						title={track.album}
						aria-label={`Go to album ${track.album}`}
						onClick={(e) => {
							if (onAlbumClick) {
								e.stopPropagation();
								onAlbumClick(track);
							}
						}}
					>
						{track.album}
					</button>
				)}
				<div className="col-time">{formatTime(track.duration_secs)}</div>
			</div>
		);
	},
);

export default function SongTable({
	tracks,
	hideAlbumColumn,
	hideArtwork,
	compact = false,
	scrollRef,
}: SongTableProps) {
	const currentTrack = usePlayerStore((s) => s.currentTrack);
	const isPlaying = usePlayerStore((s) => s.isPlaying);
	const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
	const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
	const setActiveLibraryView = useUiStore((s) => s.setActiveLibraryView);
	const setActiveSection = useUiStore((s) => s.setActiveSection);
	const albums = useLibraryStore((s) => s.albums);
	const artists = useLibraryStore((s) => s.artists);
	const artistsByName = useMemo(
		() => new Map(artists.map((artist) => [artist.name, artist])),
		[artists],
	);
	const parentRef = useRef<HTMLDivElement>(null);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		track: Track;
	} | null>(null);
	const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
	const [focusedRowIndex, setFocusedRowIndex] = useState(0);
	const pendingFocusIndexRef = useRef<number | null>(null);
	const focusedTrackIdRef = useRef<string | null>(tracks[0]?.id ?? null);
	const songRowHadFocusRef = useRef(false);
	const [tracksForPlaylist, setTracksForPlaylist] = useState<Track[] | null>(null);
	const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);

	// Virtualizer for handling large lists (e.g. 20,000+ songs) smoothly
	const [scrollMargin, setScrollMargin] = useState(0);
	useLayoutEffect(() => {
		if (!scrollRef?.current || !parentRef.current) return;
		const update = () => {
			const listTop = parentRef.current!.getBoundingClientRect().top;
			const scrollTop = scrollRef!.current!.getBoundingClientRect().top;
			setScrollMargin(listTop - scrollTop + scrollRef!.current!.scrollTop);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(parentRef.current);
		return () => observer.disconnect();
	}, [scrollRef]);

	const rowVirtualizer = useVirtualizer({
		count: tracks.length,
		getScrollElement: () => scrollRef ? scrollRef.current : parentRef.current,
		estimateSize: () => compact ? 36 : 48,
		overscan: 6,
		scrollMargin: scrollRef ? scrollMargin : 0,
	});
	const virtualItems = rowVirtualizer.getVirtualItems();
	const firstVirtualIndex = virtualItems[0]?.index ?? -1;
	const lastVirtualIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
	const loadArtworkPaused = !!rowVirtualizer.isScrolling;

	useLayoutEffect(() => {
		const pendingIndex = pendingFocusIndexRef.current;
		if (pendingIndex !== null) {
			const pendingRow = parentRef.current?.querySelector<HTMLElement>(
				`[data-song-index="${pendingIndex}"]`,
			);
			if (pendingRow) {
				pendingRow.focus();
				pendingFocusIndexRef.current = null;
			}
			return;
		}

		if (!songRowHadFocusRef.current || !parentRef.current || !tracks.length) return;
		const activeElement = document.activeElement;
		const activeRow =
			activeElement instanceof Element
				? activeElement.closest<HTMLElement>("[data-song-index]")
				: null;
		if (activeRow && parentRef.current.contains(activeRow)) return;
		if (
			activeElement !== document.body &&
			activeElement !== document.documentElement
		) {
			return;
		}

		const viewport = scrollRef?.current ?? parentRef.current;
		const viewportRect = viewport.getBoundingClientRect();
		const visibleRows = virtualItems.flatMap((item) => {
			const row = parentRef.current?.querySelector<HTMLElement>(
				`[data-song-index="${item.index}"]`,
			);
			if (!row) return [];
			const rect = row.getBoundingClientRect();
			return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
				? [{ row, index: item.index }]
				: [];
		});
		const fallback = visibleRows[0] ??
			(virtualItems[0]
				? {
						row: parentRef.current.querySelector<HTMLElement>(
							`[data-song-index="${virtualItems[0].index}"]`,
						),
						index: virtualItems[0].index,
					}
				: null);
		if (fallback?.row) {
			focusedTrackIdRef.current = tracks[fallback.index]?.id ?? null;
			setFocusedRowIndex(fallback.index);
			fallback.row.focus();
		}
	}, [focusedRowIndex, firstVirtualIndex, lastVirtualIndex, tracks, scrollRef]);
	const selectedTracks = useMemo(
		() => getSelectedTracksInVisibleOrder(tracks, selectedTrackIds),
		[tracks, selectedTrackIds],
	);

	useLayoutEffect(() => {
		const visibleIds = new Set(tracks.map((track) => track.id));
		setSelectedTrackIds((current) => {
			const next = new Set([...current].filter((id) => visibleIds.has(id)));
			return next.size === current.size ? current : next;
		});
		setSelectionAnchorId((current) =>
			current && visibleIds.has(current) ? current : null,
		);
		if (tracks.length === 0) {
			focusedTrackIdRef.current = null;
			pendingFocusIndexRef.current = null;
			setFocusedRowIndex(0);
			songRowHadFocusRef.current = false;
			return;
		}
		const preservedIndex = tracks.findIndex(
			(track) => track.id === focusedTrackIdRef.current,
		);
		const nextIndex = preservedIndex >= 0 ? preservedIndex : 0;
		focusedTrackIdRef.current = tracks[nextIndex].id;
		setFocusedRowIndex(nextIndex);
		pendingFocusIndexRef.current = songRowHadFocusRef.current ? nextIndex : null;
		rowVirtualizer.scrollToIndex(nextIndex, { align: "center" });
	}, [tracks]);

	const handlePlay = (track: Track) =>
		runActionWithFeedback(() => playTrack(track.id), {
			failureMessage: `Couldn't play "${track.title}".`,
		});

	const handleSelect = (
		track: Track,
		index: number,
		checked: boolean,
		modifiers: SelectionModifiers,
	) => {
		const selection = updateSongSelection(
			selectedTrackIds,
			tracks,
			track.id,
			checked,
			selectionAnchorId,
			modifiers,
		);
		setSelectedTrackIds(selection.selectedIds);
		setSelectionAnchorId(selection.anchorTrackId);
		setFocusedRowIndex(index);
		focusedTrackIdRef.current = track.id;
	};

	const handleMoveFocus = (index: number) => {
		if (index < 0 || index >= tracks.length) return;
		pendingFocusIndexRef.current = index;
		setFocusedRowIndex(index);
		focusedTrackIdRef.current = tracks[index]?.id ?? null;
		rowVirtualizer.scrollToIndex(index, { align: "auto" });
	};

	const handleFocusRow = (index: number) => {
		setFocusedRowIndex(index);
		focusedTrackIdRef.current = tracks[index]?.id ?? null;
		songRowHadFocusRef.current = true;
	};

	const handleBlurRow = (relatedTarget: EventTarget | null) => {
		if (!relatedTarget) return;
		const nextElement = relatedTarget instanceof Element ? relatedTarget : null;
		songRowHadFocusRef.current = !!(
			nextElement &&
			parentRef.current?.contains(nextElement) &&
			nextElement.closest("[data-song-index]")
		);
	};

	const handleBulkAddToQueue = async () => {
		if (selectedTracks.length === 0) return;
		try {
			await addTracksToQueue(selectedTracks.map((track) => track.id));
			useToastStore
				.getState()
				.addToast(`Added ${selectedTracks.length} songs to queue`, "success");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			useToastStore
				.getState()
				.addToast(`Couldn't add songs to queue: ${message}`, "error");
		}
	};

	const handleAddToQueue = (track: Track) =>
		runActionWithFeedback(() => addToQueue(track.id), {
			failureMessage: `Couldn't add "${track.title}" to the queue.`,
			successMessage: `Added "${track.title}" to queue`,
		});

	const handleContextMenu = (e: React.MouseEvent, track: Track) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, track });
	};

	const handleArtistClick = (track: Track) => {
		const artistObj =
			artistsByName.get(track.album_artist) || artistsByName.get(track.artist);
		if (artistObj) {
			setActiveSection("library");
			setActiveLibraryView("artists");
			setSelectedArtist(artistObj);
		}
	};

	const handleAlbumClick = (track: Track) => {
		const albumObj = findTrackAlbum(albums, track);

		if (albumObj) {
			setActiveSection("library");
			setActiveLibraryView("albums");
			setSelectedAlbum(albumObj);
		}
	};

	const getContextMenuItems = (track: Track): ContextMenuItem[] => [
		{
			label: "Play",
			icon: <Play size={14} />,
			onClick: () => handlePlay(track),
		},
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: () => handleAddToQueue(track),
		},
		{
			label: "Play Next",
			icon: <ListPlus size={14} />,
			onClick: () =>
				runActionWithFeedback(() => addToQueueNext(track.id), {
					failureMessage: `Couldn't play "${track.title}" next.`,
					successMessage: `Queued "${track.title}" to play next`,
				}),
		},
		{
			label: "Add to Playlist...",
			icon: <ListPlus size={14} />,
			onClick: () => setTracksForPlaylist([track]),
		},
		{
			label: "Go to Album",
			icon: <Disc size={14} />,
			onClick: () => handleAlbumClick(track),
		},
		{
			label: "Song Info",
			icon: <Info size={14} />,
			onClick: () => setMetadataTrack(track),
		},
	];

	if (tracks.length === 0) {
		return (
			<div className="empty-state">
				<p>No songs found in your library.</p>
			</div>
		);
	}

	return (
		<div className={`song-table-container${compact ? " song-table-container--compact" : ""}`} ref={parentRef}>
			<div className="song-table-header">
				<div className="col-play">#</div>
				<div className="col-title">Title</div>
				<div className="col-artist">Artist</div>
				{!hideAlbumColumn && <div className="col-album">Album</div>}
				<div className="col-time">Time</div>
			</div>
			{selectedTracks.length > 0 && (
				<div className="song-selection-toolbar" role="toolbar" aria-label="Bulk actions for selected songs">
					<span className="song-selection-count" aria-live="polite">
						{selectedTracks.length} selected
					</span>
					<button type="button" className="btn btn-ghost" onClick={handleBulkAddToQueue}>
						<ListPlus size={14} /> Add to Queue
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => setTracksForPlaylist(selectedTracks)}>
						<ListPlus size={14} /> Add to Playlist
					</button>
					<button
						type="button"
						className="btn btn-ghost song-selection-clear"
						onClick={() => {
							setSelectedTrackIds(new Set());
							setSelectionAnchorId(null);
						}}
						aria-label="Clear selected songs"
					>
						<X size={14} />
					</button>
				</div>
			)}

			<div
				className="song-table-body"
				role="list"
				aria-label="Songs"
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
							totalTracks={tracks.length}
							scrollMargin={scrollMargin}
							hideAlbumColumn={hideAlbumColumn}
							hideArtwork={hideArtwork}
							loadArtworkPaused={loadArtworkPaused}
							onPlay={handlePlay}
							onContextMenu={handleContextMenu}
							onSelect={handleSelect}
							onMoveFocus={handleMoveFocus}
							onFocusRow={handleFocusRow}
							onBlurRow={handleBlurRow}
							selected={selectedTrackIds.has(track.id)}
							focused={focusedRowIndex === virtualRow.index}
							onAlbumClick={handleAlbumClick}
							onArtistClick={handleArtistClick}
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

			{tracksForPlaylist && (
				<AddToPlaylistModal
					tracks={tracksForPlaylist}
					onClose={() => setTracksForPlaylist(null)}
				/>
			)}

			{metadataTrack && (
				<TrackMetadataModal
					track={metadataTrack}
					onClose={() => setMetadataTrack(null)}
				/>
			)}
		</div>
	);
}

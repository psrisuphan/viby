import { useRef, useState, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Play, ListPlus, Info } from "lucide-react";
import type { Track } from "../../types";
import { formatTime } from "../../utils/formatTime";
import { usePlayerStore } from "../../stores/playerStore";
import { useToastStore } from "../../stores/toastStore";
import { playTrack, addToQueue, addToQueueNext } from "../../utils/tauri";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import { memo } from "react";
import { useArtwork } from "../../utils/useArtwork";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import AddToPlaylistModal from "../playlist/AddToPlaylistModal";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import { Disc } from "lucide-react";
import "./SongTable.css";

interface SongTableProps {
	tracks: Track[];
	hideAlbumColumn?: boolean;
	hideArtwork?: boolean;
	scrollRef?: React.RefObject<HTMLElement | null>;
}

interface SongRowProps {
	track: Track;
	isCurrent: boolean;
	isPlaying: boolean;
	virtualRow: any;
	scrollMargin: number;
	hideAlbumColumn?: boolean;
	hideArtwork?: boolean;
	loadArtworkPaused?: boolean;
	onPlay: (track: Track) => void;
	onContextMenu: (e: React.MouseEvent, track: Track) => void;
	onAlbumClick?: (track: Track) => void;
	onArtistClick?: (track: Track) => void;
}

const SongRow = memo(
	({
		track,
		isCurrent,
		isPlaying,
		virtualRow,
		scrollMargin,
		hideAlbumColumn,
		hideArtwork,
		loadArtworkPaused,
		onPlay,
		onContextMenu,
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
				className={`song-row ${isCurrent ? "active" : ""}`}
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: `${virtualRow.size}px`,
					transform: `translateY(${virtualRow.start - scrollMargin}px)`,
				}}
				onDoubleClick={() => onPlay(track)}
				onContextMenu={(e) => onContextMenu(e, track)}
			>
				<div className="col-play">
					<span className="track-number">
						{track.track_number || virtualRow.index + 1}
					</span>
					<button className="row-play-btn" onClick={() => onPlay(track)}>
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
				<div
					className="col-artist truncate clickable"
					title={track.artist}
					onClick={(e) => {
						if (onArtistClick) {
							e.stopPropagation();
							onArtistClick(track);
						}
					}}
				>
					{track.artist}
				</div>
				{!hideAlbumColumn && (
					<div
						className="col-album truncate clickable"
						title={track.album}
						onClick={(e) => {
							if (onAlbumClick) {
								e.stopPropagation();
								onAlbumClick(track);
							}
						}}
					>
						{track.album}
					</div>
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
	const parentRef = useRef<HTMLDivElement>(null);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		track: Track;
	} | null>(null);
	const [selectedTrackForPlaylist, setSelectedTrackForPlaylist] =
		useState<Track | null>(null);
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
		estimateSize: () => 48,
		overscan: 6,
		scrollMargin: scrollRef ? scrollMargin : 0,
	});
	const loadArtworkPaused = !!rowVirtualizer.isScrolling;

	const handlePlay = async (track: Track) => {
		await playTrack(track.id);
	};

	const handleAddToQueue = async (track: Track) => {
		await addToQueue(track);
		useToastStore
			.getState()
			.addToast(`Added "${track.title}" to queue`, "success");
	};

	const handleContextMenu = (e: React.MouseEvent, track: Track) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, track });
	};

	const handleArtistClick = (track: Track) => {
		const artistObj =
			artists.find((a) => a.name === track.album_artist) ||
			artists.find((a) => a.name === track.artist);
		if (artistObj) {
			setActiveSection("library");
			setActiveLibraryView("artists");
			setSelectedArtist(artistObj);
		}
	};

	const handleAlbumClick = (track: Track) => {
		// Find the full album object. Try to match album_artist first, then artist, then just name.
		const albumObj =
			albums.find(
				(a) => a.name === track.album && a.artist === track.album_artist,
			) ||
			albums.find((a) => a.name === track.album && a.artist === track.artist) ||
			albums.find((a) => a.name === track.album);

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
			onClick: async () => {
				await addToQueueNext(track);
				useToastStore
					.getState()
					.addToast(`Queued "${track.title}" to play next`, "success");
			},
		},
		{
			label: "Add to Playlist...",
			icon: <ListPlus size={14} />,
			onClick: () => setSelectedTrackForPlaylist(track),
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
		<div className="song-table-container" ref={parentRef}>
			<div className="song-table-header">
				<div className="col-play">#</div>
				<div className="col-title">Title</div>
				<div className="col-artist">Artist</div>
				{!hideAlbumColumn && <div className="col-album">Album</div>}
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
						<SongRow
							key={track.id}
							track={track}
							isCurrent={isCurrent}
							isPlaying={isPlaying}
							virtualRow={virtualRow}
							scrollMargin={scrollMargin}
							hideAlbumColumn={hideAlbumColumn}
							hideArtwork={hideArtwork}
							loadArtworkPaused={loadArtworkPaused}
							onPlay={handlePlay}
							onContextMenu={handleContextMenu}
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

			{selectedTrackForPlaylist && (
				<AddToPlaylistModal
					track={selectedTrackForPlaylist}
					onClose={() => setSelectedTrackForPlaylist(null)}
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

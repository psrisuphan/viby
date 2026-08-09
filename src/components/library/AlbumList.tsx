import {
	useRef,
	useState,
	useLayoutEffect,
	type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Disc, ListPlus, Info, Play } from "lucide-react";
import type { Album } from "../../types";
import { useArtwork } from "../../utils/useArtwork";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import {
	playTrack,
	clearQueue,
	addTracksToQueue,
	addTracksToQueueNext,
	getAlbumTracks,
} from "../../utils/tauri";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import AlbumInfoModal from "../ui/AlbumInfoModal";
import "./AlbumList.css";

interface AlbumListProps {
	albums: Album[];
	scrollRef?: RefObject<HTMLElement | null>;
}

function AlbumRow({
	album,
	onClick,
	onArtistClick,
	loadArtworkPaused,
}: {
	album: Album;
	onClick?: () => void;
	onArtistClick?: (artistName: string) => void;
	loadArtworkPaused?: boolean;
}) {
	const { artworkUrl, isLoading } = useArtwork(
		album.artwork_track_id,
		`${album.name}||${album.artist}`,
		{ paused: loadArtworkPaused, size: 128 },
	);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const [showInfo, setShowInfo] = useState(false);

	const handlePlayAlbum = async () => {
		const albumTracks = await getAlbumTracks(album.name, album.artist).catch(
			() => [],
		);
		if (albumTracks.length === 0) return;

		try {
			await clearQueue();
			await playTrack(albumTracks[0].id);
			if (albumTracks.length > 1) {
				await addTracksToQueue(albumTracks.slice(1));
			}
		} catch (err: any) {
			console.error("Play album failed:", err);
			useToastStore
				.getState()
				.addToast(`Play album failed: ${err.toString()}`, "error");
		}
	};

	const handleAddToQueue = async () => {
		const albumTracks = await getAlbumTracks(album.name, album.artist).catch(
			() => [],
		);
		if (albumTracks.length === 0) return;
		try {
			await addTracksToQueue(albumTracks);
			useToastStore
				.getState()
				.addToast(
					`Added ${albumTracks.length} track${albumTracks.length !== 1 ? "s" : ""} to queue`,
					"success",
				);
		} catch (err: any) {
			useToastStore
				.getState()
				.addToast(`Failed to add to queue: ${err.toString()}`, "error");
		}
	};

	const handlePlayNext = async () => {
		const albumTracks = await getAlbumTracks(album.name, album.artist).catch(
			() => [],
		);
		if (albumTracks.length === 0) return;
		try {
			await addTracksToQueueNext(albumTracks);
			useToastStore
				.getState()
				.addToast(
					`Queued ${albumTracks.length} track${albumTracks.length !== 1 ? "s" : ""} to play next`,
					"success",
				);
		} catch (err: any) {
			useToastStore
				.getState()
				.addToast(`Failed to queue next: ${err.toString()}`, "error");
		}
	};

	const contextMenuItems: ContextMenuItem[] = [
		{
			label: "Play",
			icon: <Play size={14} />,
			onClick: handlePlayAlbum,
		},
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: handleAddToQueue,
		},
		{
			label: "Play Next",
			icon: <ListPlus size={14} />,
			onClick: handlePlayNext,
		},
		{
			label: "Album Info",
			icon: <Info size={14} />,
			onClick: () => setShowInfo(true),
		},
	];

	return (
		<>
			<div
				className="album-list-row group"
				onClick={onClick}
				onContextMenu={(e) => {
					e.preventDefault();
					setContextMenu({ x: e.clientX, y: e.clientY });
				}}
			>
				<div className="album-list-art-container">
					{artworkUrl ? (
						<img
							src={artworkUrl}
							alt={album.name}
							className="album-list-art"
						/>
					) : (
						<div className="album-list-art-placeholder">
							<Disc
								size={28}
								className={`text-tertiary ${!isLoading ? "group-hover:scale-110 transition-transform duration-300" : "animate-pulse"}`}
							/>
						</div>
					)}
					<button
						className="album-list-play-btn"
						onClick={(e) => {
							e.stopPropagation();
							void handlePlayAlbum();
						}}
						title="Play album"
					>
						<Play size={16} fill="currentColor" />
					</button>
				</div>
				<div className="album-list-info">
					<h3 className="album-list-title truncate" title={album.name}>
						{album.name}
					</h3>
					<button
						type="button"
						className="album-list-artist truncate"
						title={album.artist}
						onClick={(e) => {
							e.stopPropagation();
							onArtistClick?.(album.artist);
						}}
					>
						{album.artist}
					</button>
					<p className="album-list-meta">
						{album.year ?? "Unknown year"}{" "}
						<span className="album-list-meta-separator">•</span>{" "}
						{album.track_count.toLocaleString()} songs
					</p>
				</div>
			</div>
			{contextMenu && (
				<ContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}
			{showInfo && (
				<AlbumInfoModal album={album} onClose={() => setShowInfo(false)} />
			)}
		</>
	);
}

const ROW_HEIGHT = 96;

export default function AlbumList({ albums, scrollRef }: AlbumListProps) {
	const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
	const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
	const artists = useLibraryStore((s) => s.artists);
	const listRef = useRef<HTMLDivElement>(null);
	const [scrollMargin, setScrollMargin] = useState(0);

	const handleArtistClick = (artistName: string) => {
		const artist = artists.find((candidate) => candidate.name === artistName);
		if (artist) setSelectedArtist(artist);
	};

	useLayoutEffect(() => {
		if (!scrollRef?.current || !listRef.current) return;
		const update = () => {
			const listTop = listRef.current!.getBoundingClientRect().top;
			const scrollTop = scrollRef!.current!.getBoundingClientRect().top;
			setScrollMargin(listTop - scrollTop + scrollRef!.current!.scrollTop);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(listRef.current);
		return () => observer.disconnect();
	}, [scrollRef]);

	const rowVirtualizer = useVirtualizer({
		count: albums.length,
		getScrollElement: () => scrollRef?.current ?? listRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 4,
		scrollMargin: scrollRef ? scrollMargin : 0,
	});

	if (albums.length === 0) {
		return (
			<div className="empty-state">
				<p>No albums found in your library.</p>
			</div>
		);
	}

	return (
		<div
			className="album-list"
			ref={listRef}
			style={{ position: "relative", height: `${rowVirtualizer.getTotalSize()}px` }}
		>
			{rowVirtualizer.getVirtualItems().map((virtualRow) => {
				const album = albums[virtualRow.index];
				return (
					<div
						key={`${album.name}-${album.artist}-${virtualRow.index}`}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: `${virtualRow.size}px`,
							transform: `translateY(${virtualRow.start - scrollMargin}px)`,
						}}
					>
						<AlbumRow
							album={album}
								loadArtworkPaused={rowVirtualizer.isScrolling}
								onClick={() => setSelectedAlbum(album)}
								onArtistClick={handleArtistClick}
						/>
					</div>
				);
			})}
		</div>
	);
}

import {
	useRef,
	useState,
	useLayoutEffect,
	useEffect,
	useMemo,
	type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Album } from "../../types";
import { Disc, ListPlus, Info } from "lucide-react";
import { useArtwork } from "../../utils/useArtwork";
import { useUiStore } from "../../stores/uiStore";
import { useToastStore } from "../../stores/toastStore";
import {
	playTrack,
	clearQueue,
	addTracksToQueue,
	getAlbumTracks,
} from "../../utils/tauri";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import AlbumInfoModal from "../ui/AlbumInfoModal";
import CustomScrollbar from "../ui/CustomScrollbar";
import "./AlbumGrid.css";

interface AlbumGridProps {
	albums: Album[];
	horizontal?: boolean;
	scrollRef?: RefObject<HTMLElement | null>;
}

function AlbumCard({ album, onClick }: { album: Album; onClick?: () => void }) {
	const { artworkUrl, isLoading } = useArtwork(
		album.artwork_track_id,
		`${album.name}||${album.artist}`,
	);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const [showInfo, setShowInfo] = useState(false);

	const handlePlayAlbum = async (e: React.MouseEvent) => {
		e.stopPropagation();

		// Fetch album tracks from backend — avoids O(n) filter over the full store.
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

	const contextMenuItems: ContextMenuItem[] = [
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: handleAddToQueue,
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
				className="album-card group"
				onClick={onClick}
				onContextMenu={(e) => {
					e.preventDefault();
					setContextMenu({ x: e.clientX, y: e.clientY });
				}}
			>
				<div className="album-art-container">
					{artworkUrl ? (
						<img
							src={artworkUrl}
							alt={album.name}
							className="album-art-image"
						/>
					) : (
						<div className="album-art-placeholder">
							<Disc
								size={48}
								className={`text-tertiary ${!isLoading ? "group-hover:scale-110 transition-transform duration-300" : "animate-pulse"}`}
							/>
						</div>
					)}
					<div className="album-hover-overlay">
						<button className="play-album-btn" onClick={handlePlayAlbum}>
							<svg
								viewBox="0 0 24 24"
								fill="currentColor"
								width="24"
								height="24"
							>
								<path d="M8 5v14l11-7z" />
							</svg>
						</button>
					</div>
				</div>
				<div className="album-info">
					<h3 className="album-title truncate" title={album.name}>
						{album.name}
					</h3>
					<p className="album-artist truncate" title={album.artist}>
						{album.artist}
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

// Minimum card width matches CSS minmax(170px, 1fr); gap is var(--space-lg) = 16px
const CARD_MIN_WIDTH = 170;
const GRID_GAP = 16;

function computeColumnCount(containerWidth: number): number {
	return Math.max(
		1,
		Math.floor((containerWidth + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)),
	);
}

function computeRowHeight(containerWidth: number, columnCount: number): number {
	const cardWidth =
		(containerWidth - (columnCount - 1) * GRID_GAP) / columnCount;
	// card padding (8 top + 8 bottom) + art (square) + gap (8) + info (~41px)
	return Math.round(8 + cardWidth + 8 + 41 + 8 + GRID_GAP);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		rows.push(arr.slice(i, i + size));
	}
	return rows;
}

export default function AlbumGrid({
	albums,
	horizontal,
	scrollRef,
}: AlbumGridProps) {
	const { setSelectedAlbum } = useUiStore();
	const containerRef = useRef<HTMLDivElement>(null);
	const horizontalScrollRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const [scrollMargin, setScrollMargin] = useState(0);

	// Measure container width for column count calculation
	useEffect(() => {
		if (!containerRef.current) return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setContainerWidth(width);
		});
		observer.observe(containerRef.current);
		setContainerWidth(containerRef.current.getBoundingClientRect().width);
		return () => observer.disconnect();
	}, []);

	const columnCount =
		containerWidth > 0 ? computeColumnCount(containerWidth) : 4;
	const estimatedRowHeight =
		containerWidth > 0 ? computeRowHeight(containerWidth, columnCount) : 300;

	const rows = useMemo(
		() => chunkArray(albums, columnCount),
		[albums, columnCount],
	);

	useLayoutEffect(() => {
		if (!scrollRef?.current || !containerRef.current || horizontal) return;
		const update = () => {
			const listTop = containerRef.current!.getBoundingClientRect().top;
			const scrollTop = scrollRef!.current!.getBoundingClientRect().top;
			setScrollMargin(listTop - scrollTop + scrollRef!.current!.scrollTop);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(containerRef.current);
		return () => observer.disconnect();
	}, [scrollRef, horizontal]);

	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () =>
			horizontal ? null : (scrollRef?.current ?? containerRef.current),
		estimateSize: () => estimatedRowHeight,
		overscan: 3,
		scrollMargin: scrollRef && !horizontal ? scrollMargin : 0,
	});

	if (albums.length === 0) {
		return (
			<div className="empty-state">
				<p>No albums found in your library.</p>
			</div>
		);
	}

	// Horizontal mode: unchanged, no virtualization needed (small fixed list)
	if (horizontal) {
		return (
			<div className="album-grid-horizontal-wrapper scrollbar-host">
				<div className="album-grid horizontal" ref={horizontalScrollRef}>
					{albums.map((album, idx) => (
						<AlbumCard
							key={`${album.name}-${album.artist}-${idx}`}
							album={album}
							onClick={() => setSelectedAlbum(album)}
						/>
					))}
				</div>
				<CustomScrollbar
					scrollRef={horizontalScrollRef}
					orientation="horizontal"
				/>
			</div>
		);
	}

	// Vertical mode: virtualized rows
	const effectiveScrollMargin = scrollRef ? scrollMargin : 0;

	return (
		<div
			ref={containerRef}
			style={{
				position: "relative",
				height: `${rowVirtualizer.getTotalSize()}px`,
				padding: "8px 0",
			}}
		>
			{rowVirtualizer.getVirtualItems().map((virtualRow) => {
				const rowAlbums = rows[virtualRow.index];
				return (
					<div
						key={virtualRow.index}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: `${virtualRow.size}px`,
							transform: `translateY(${virtualRow.start - effectiveScrollMargin}px)`,
							display: "flex",
							gap: `${GRID_GAP}px`,
						}}
					>
						{rowAlbums.map((album, i) => {
							const globalIdx = virtualRow.index * columnCount + i;
							return (
								<div
									key={`${album.name}-${album.artist}-${globalIdx}`}
									style={{ flex: 1, minWidth: 0 }}
								>
									<AlbumCard
										album={album}
										onClick={() => setSelectedAlbum(album)}
									/>
								</div>
							);
						})}
						{/* Fill empty slots in the last row so cards stay the same width */}
						{rowAlbums.length < columnCount &&
							Array.from({ length: columnCount - rowAlbums.length }).map(
								(_, i) => (
									<div key={`empty-${i}`} style={{ flex: 1, minWidth: 0 }} />
								),
							)}
					</div>
				);
			})}
		</div>
	);
}

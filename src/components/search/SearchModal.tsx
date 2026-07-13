import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Play, Music, Disc, Mic2, ListPlus, Info } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import { searchLibrary, playTrack, addToQueue, addToQueueNext, getAlbumTracks, clearQueue, addTracksToQueue, addTracksToQueueNext } from "../../utils/tauri";
import { useArtwork } from "../../utils/useArtwork";
import type { SearchResults, Album, Artist, Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import AddToPlaylistModal from "../playlist/AddToPlaylistModal";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import AlbumInfoModal from "../ui/AlbumInfoModal";
import "./SearchModal.css";

function SearchTrackItem({
	track,
	onPlay,
	onContextMenu,
}: {
	track: Track;
	onPlay: (id: string) => void;
	onContextMenu: (e: React.MouseEvent, track: Track) => void;
}) {
	const { artworkUrl } = useArtwork(
		track.id,
		`${track.album}||${track.album_artist}`,
	);

	return (
		<div
			className="search-item search-track-item"
			onDoubleClick={() => onPlay(track.id)}
			onContextMenu={(e) => onContextMenu(e, track)}
		>
			<div className="search-item-artwork-container">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" className="search-item-artwork" />
				) : (
					<div className="search-item-artwork-placeholder">
						<Music size={16} />
					</div>
				)}
				<button className="search-item-play" onClick={() => onPlay(track.id)}>
					<Play size={14} fill="currentColor" style={{ marginLeft: "1.5px" }} />
				</button>
			</div>
			<div className="search-item-info">
				<div className="search-item-title truncate">{track.title}</div>
				<div className="search-item-subtitle truncate">
					{track.artist} • {track.album}
				</div>
			</div>
		</div>
	);
}

function SearchAlbumItem({
	album,
	onClick,
	onContextMenu,
}: {
	album: Album;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent, album: Album) => void;
}) {
	const { artworkUrl } = useArtwork(
		album.artwork_track_id,
		`${album.name}||${album.artist}`,
	);

	return (
		<div
			className="search-item search-album-item"
			onClick={onClick}
			onContextMenu={(e) => onContextMenu(e, album)}
		>
			<div className="search-item-artwork-container">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" className="search-item-artwork" />
				) : (
					<div className="search-item-artwork-placeholder">
						<Disc size={16} />
					</div>
				)}
			</div>
			<div className="search-item-info">
				<div className="search-item-title truncate">{album.name}</div>
				<div className="search-item-subtitle truncate">
					{album.artist} • {album.track_count} tracks
				</div>
			</div>
		</div>
	);
}

function SearchArtistItem({
	artist,
	artworkTrackId,
	onClick,
}: {
	artist: Artist;
	artworkTrackId: string | null;
	onClick: () => void;
}) {
	const { artworkUrl } = useArtwork(artworkTrackId);

	return (
		<div className="search-item search-artist-item" onClick={onClick}>
			<div className="search-item-artwork-container search-item-artwork-container--round">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" className="search-item-artwork" />
				) : (
					<div className="search-item-artwork-placeholder">
						<Mic2 size={16} />
					</div>
				)}
			</div>
			<div className="search-item-info">
				<div className="search-item-title truncate">{artist.name}</div>
				<div className="search-item-subtitle truncate">
					{artist.album_count} albums • {artist.track_count} tracks
				</div>
			</div>
		</div>
	);
}

export default function SearchModal() {
	const setSearchOpen = useUiStore((s) => s.setSearchOpen);
	const setActiveSection = useUiStore((s) => s.setActiveSection);
	const setActiveLibraryView = useUiStore((s) => s.setActiveLibraryView);
	const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
	const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
	const inputRef = useRef<HTMLInputElement>(null);
	const resultsRef = useRef<HTMLDivElement>(null);
	const albums = useLibraryStore((s) => s.albums);
	const artistArtworkIds = useMemo(() => {
		const ids = new Map<string, string>();
		for (const album of albums) {
			if (album.artwork_track_id && !ids.has(album.artist)) {
				ids.set(album.artist, album.artwork_track_id);
			}
		}
		return ids;
	}, [albums]);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResults | null>(null);
	const [isSearching, setIsSearching] = useState(false);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		type: "track" | "album";
		item: any;
	} | null>(null);
	const [selectedTrackForPlaylist, setSelectedTrackForPlaylist] = useState<Track | null>(null);
	const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);
	const [infoAlbum, setInfoAlbum] = useState<Album | null>(null);

	const handleTrackContextMenu = (e: React.MouseEvent, track: Track) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, type: "track", item: track });
	};

	const handleAlbumContextMenu = (e: React.MouseEvent, album: Album) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, type: "album", item: album });
	};

	const getTrackContextMenuItems = (track: Track): ContextMenuItem[] => [
		{
			label: "Play",
			icon: <Play size={14} />,
			onClick: () => {
				handlePlaySong(track.id);
				setContextMenu(null);
			},
		},
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: () => {
				addToQueue(track);
				useToastStore
					.getState()
					.addToast(`Added "${track.title}" to queue`, "success");
				setContextMenu(null);
			},
		},
		{
			label: "Play Next",
			icon: <ListPlus size={14} />,
			onClick: async () => {
				await addToQueueNext(track);
				useToastStore
					.getState()
					.addToast(`Queued "${track.title}" to play next`, "success");
				setContextMenu(null);
			},
		},
		{
			label: "Add to Playlist...",
			icon: <ListPlus size={14} />,
			onClick: () => {
				setSelectedTrackForPlaylist(track);
				setContextMenu(null);
			},
		},
		{
			label: "Song Info",
			icon: <Info size={14} />,
			onClick: () => {
				setMetadataTrack(track);
				setContextMenu(null);
			},
		},
	];

	const getAlbumContextMenuItems = (album: Album): ContextMenuItem[] => [
		{
			label: "Play",
			icon: <Play size={14} />,
			onClick: async () => {
				const tracks = await getAlbumTracks(album.name, album.artist);
				if (tracks.length > 0) {
					await clearQueue();
					await addTracksToQueue(tracks);
					await playTrack(tracks[0].id);
				}
				setContextMenu(null);
			},
		},
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: async () => {
				const tracks = await getAlbumTracks(album.name, album.artist);
				if (tracks.length > 0) {
					await addTracksToQueue(tracks);
					useToastStore
						.getState()
						.addToast(`Added album "${album.name}" to queue`, "success");
				}
				setContextMenu(null);
			},
		},
		{
			label: "Play Next",
			icon: <ListPlus size={14} />,
			onClick: async () => {
				const tracks = await getAlbumTracks(album.name, album.artist);
				if (tracks.length > 0) {
					await addTracksToQueueNext(tracks);
					useToastStore
						.getState()
						.addToast(`Queued album "${album.name}" to play next`, "success");
				}
				setContextMenu(null);
			},
		},
		{
			label: "Album Info",
			icon: <Info size={14} />,
			onClick: () => {
				setInfoAlbum(album);
				setContextMenu(null);
			},
		},
	];

	useEffect(() => {
		// Focus input on mount
		inputRef.current?.focus();

		// Close on Escape
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSearchOpen(false);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [setSearchOpen]);

	useEffect(() => {
		if (!query.trim()) {
			setResults(null);
			setIsSearching(false);
			return;
		}

		setIsSearching(true);
		const timer = setTimeout(async () => {
			try {
				const res = await searchLibrary(query);
				setResults(res);
			} catch (e) {
				console.error("Search failed:", e);
			} finally {
				setIsSearching(false);
			}
		}, 300); // 300ms debounce

		return () => clearTimeout(timer);
	}, [query]);

	const handlePlaySong = async (trackId: string) => {
		await playTrack(trackId);
		setSearchOpen(false);
	};

	const handleAlbumClick = (album: Album) => {
		setActiveSection("library");
		setActiveLibraryView("albums");
		setSelectedAlbum(album);
		setSearchOpen(false);
	};

	const handleArtistClick = (artist: Artist) => {
		setActiveSection("library");
		setActiveLibraryView("artists");
		setSelectedArtist(artist);
		setSearchOpen(false);
	};

	return (
		<div
			className="modal-overlay animate-fade-in"
			onClick={() => setSearchOpen(false)}
		>
			<div
				className="search-modal animate-scale-in glass-panel-heavy"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="search-header">
					<Search size={20} className="search-icon" />
					<input
						ref={inputRef}
						type="text"
						placeholder="Search songs, albums, artists..."
						className="search-input"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<button className="icon-btn" onClick={() => setSearchOpen(false)}>
						<X size={20} />
					</button>
				</div>

				<div className="search-results-wrapper scrollbar-host">
					<div className="search-results" ref={resultsRef}>
						{isSearching ? (
							<div className="empty-state">
								<div className="spinner animate-spin"></div>
								<p>Searching...</p>
							</div>
						) : !results && !query ? (
							<div className="empty-state">
								<p>Type to start searching your library</p>
							</div>
						) : results &&
							results.tracks.length === 0 && results.albums.length === 0 &&
							results.artists.length === 0 ? (
							<div className="empty-state">
								<p>No results found for "{query}"</p>
							</div>
						) : results ? (
							<div className="search-sections">
								{results.tracks.length > 0 && (
									<div className="search-section">
										<h3>Songs</h3>
										<div className="search-list">
											{results.tracks.slice(0, 5).map((track) => (
												<SearchTrackItem
													key={track.id}
													track={track}
													onPlay={handlePlaySong}
													onContextMenu={handleTrackContextMenu}
												/>
											))}
										</div>
									</div>
								)}

								{results.albums.length > 0 && (
									<div className="search-section">
										<h3>Albums</h3>
										<div className="search-list">
											{results.albums.slice(0, 3).map((album, i) => (
												<SearchAlbumItem
													key={`album-${i}`}
													album={album}
													onClick={() => handleAlbumClick(album)}
													onContextMenu={handleAlbumContextMenu}
												/>
											))}
										</div>
									</div>
								)}

								{results.artists.length > 0 && (
									<div className="search-section">
										<h3>Artists</h3>
										<div className="search-list">
											{results.artists.slice(0, 3).map((artist, i) => (
												<SearchArtistItem
													key={`artist-${i}`}
													artist={artist}
													artworkTrackId={artistArtworkIds.get(artist.name) ?? null}
													onClick={() => handleArtistClick(artist)}
												/>
											))}
										</div>
									</div>
								)}
							</div>
						) : null}
					</div>
					<CustomScrollbar scrollRef={resultsRef} />
				</div>
			</div>

			{contextMenu && (
				<ContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={
						contextMenu.type === "track"
							? getTrackContextMenuItems(contextMenu.item)
							: getAlbumContextMenuItems(contextMenu.item)
					}
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

			{infoAlbum && (
				<AlbumInfoModal
					album={infoAlbum}
					onClose={() => setInfoAlbum(null)}
				/>
			)}
		</div>
	);
}

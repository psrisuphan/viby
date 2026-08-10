import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { useUiStore } from "../../stores/uiStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	Play,
	Shuffle,
	ListMusic,
	Mic2,
	Music,
	ChevronRight,
	Disc3,
	Search,
	Info,
	ListPlus,
} from "lucide-react";
import {
	playTrack,
	clearQueue,
	addToQueue,
	addToQueueNext,
	addTracksToQueue,
	getRecentlyPlayed,
	getTopArtistsPlayed,
	getRecentlyAddedTracks,
} from "../../utils/tauri";
import { shuffled } from "../../utils/randomize";
import { useArtwork } from "../../utils/useArtwork";
import { usePrefersReducedMotion } from "../../utils/usePrefersReducedMotion";
import type { Track, TopArtist } from "../../types";
import AlbumGrid from "../library/AlbumGrid";
import CustomScrollbar from "../ui/CustomScrollbar";
import ScrollArea from "../ui/ScrollArea";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import AddToPlaylistModal from "../playlist/AddToPlaylistModal";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import { findTrackAlbum } from "../../utils/findTrackAlbum";
import "./HomeView.css";

// ─── Sub-components ───────────────────────────────────────────────────────────

function AnimatedGreeting({
	text,
	reducedMotion,
}: {
	text: string;
	reducedMotion: boolean;
}) {
	const [typedText, setTypedText] = useState("");
	const [done, setDone] = useState(false);
	const message = text.includes("morning")
		? "RISE & PLAY!"
		: text.includes("afternoon")
			? "KEEP IT GOING!"
			: text.includes("evening")
				? "ONE MORE TRACK?"
				: "NIGHT OWL MODE!";

	useEffect(() => {
		if (reducedMotion) {
			setTypedText(text);
			setDone(true);
			return;
		}

		setTypedText("");
		setDone(false);
		let index = 0;
		let timer: number;
		const typeNextCharacter = () => {
			index += 1;
			setTypedText(text.slice(0, index));
			if (index === text.length) {
				timer = window.setTimeout(() => setDone(true), 220);
				return;
			}

			const character = text[index - 1];
			const pause = character === " " ? 220 : 70 + Math.random() * 90;
			timer = window.setTimeout(typeNextCharacter, pause);
		};

		timer = window.setTimeout(typeNextCharacter, 260);

		return () => window.clearTimeout(timer);
	}, [reducedMotion, text]);

	return (
		<h1 className="home-greeting" aria-label={text}>
			<span
				className={`home-greeting-text${done ? "" : " is-typing"}`}
				aria-hidden="true"
			>
				{typedText}
			</span>
			{done && (
				<span className="home-greeting-character" aria-hidden="true">
					<span className="home-greeting-face">
						<span className="home-greeting-face-eye">•</span>
						<span className="home-greeting-face-smile">ᴗ</span>
						<span className="home-greeting-face-eye">•</span>
					</span>
					<span className="home-greeting-bubble">{message}</span>
				</span>
			)}
		</h1>
	);
}

function TrackCard({
	track,
	onContextMenu,
	onAlbumClick,
	onArtistClick,
}: {
	track: Track;
	onContextMenu: (e: React.MouseEvent, track: Track) => void;
	onAlbumClick: (track: Track) => void;
	onArtistClick: (track: Track) => void;
}) {
	const { artworkUrl } = useArtwork(
		track.id,
		`${track.album}||${track.album_artist}`,
	);
	const handlePlay = async () => {
		await playTrack(track.id);
	};
	return (
		<div
			className="home-track-card"
			onClick={handlePlay}
			onContextMenu={(e) => onContextMenu(e, track)}
		>
			<div
				className="home-track-card-art"
				onClick={(e) => {
					e.stopPropagation();
					onAlbumClick(track);
				}}
				role="link"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onAlbumClick(track);
					}
				}}
				aria-label={`Open album ${track.album}`}
			>
				{artworkUrl ? (
					<img src={artworkUrl} alt="" />
				) : (
					<Music size={18} className="text-tertiary" />
				)}
				<button
					type="button"
					className="home-track-card-overlay"
					onClick={(e) => {
						e.stopPropagation();
						void handlePlay();
					}}
					aria-label={`Play ${track.title}`}
				>
					<Play size={16} fill="currentColor" />
				</button>
			</div>
			<div className="home-track-card-info">
				<div className="home-track-card-title truncate">{track.title}</div>
				<button
					type="button"
					className="home-track-card-artist truncate"
					onClick={(e) => {
						e.stopPropagation();
						onArtistClick(track);
					}}
				>
					{track.artist}
				</button>
			</div>
		</div>
	);
}

function ArtistCard({ artist }: { artist: TopArtist }) {
	const albumKey =
		artist.artwork_album && artist.artwork_album_artist
			? `${artist.artwork_album}||${artist.artwork_album_artist}`
			: undefined;
	const { artworkUrl } = useArtwork(artist.artwork_track_id ?? "", albumKey, {
		size: 128,
	});
	const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
	const artists = useLibraryStore((s) => s.artists);

	return (
		<div
			className="home-artist-card"
			onClick={() => {
				const fullArtist = artists.find((a) => a.name === artist.name) || {
					name: artist.name,
					album_count: 0,
					track_count: 0,
				};
				setSelectedArtist(fullArtist);
			}}
		>
			<div className="home-artist-art">
				{artworkUrl ? (
					<img src={artworkUrl} alt="" />
				) : (
					<Mic2 size={24} className="text-tertiary" />
				)}
			</div>
			<div className="home-artist-name truncate">{artist.name}</div>
			<div className="home-artist-plays">
				{artist.play_count.toLocaleString()} plays
			</div>
		</div>
	);
}

function LibraryStats({
	tracks,
	albums,
	artists,
	totalSecs,
}: {
	tracks: number;
	albums: number;
	artists: number;
	totalSecs: number;
}) {
	const formatDuration = (secs: number) => {
		const d = Math.floor(secs / 86400);
		const h = Math.floor((secs % 86400) / 3600);
		const m = Math.floor((secs % 3600) / 60);
		if (d > 0) return `${d}d ${h}h`;
		if (h > 0) return `${h}h ${m}m`;
		return `${m}m`;
	};

	return (
		<div className="home-stats-row">
			<div className="home-stat">
				<span className="home-stat-value">{tracks.toLocaleString()}</span>
				<span className="home-stat-label">songs</span>
			</div>
			<div className="home-stat-sep" />
			<div className="home-stat">
				<span className="home-stat-value">{albums.toLocaleString()}</span>
				<span className="home-stat-label">albums</span>
			</div>
			<div className="home-stat-sep" />
			<div className="home-stat">
				<span className="home-stat-value">{artists.toLocaleString()}</span>
				<span className="home-stat-label">artists</span>
			</div>
			<div className="home-stat-sep" />
			<div className="home-stat">
				<span className="home-stat-value">{formatDuration(totalSecs)}</span>
				<span className="home-stat-label">of music</span>
			</div>
		</div>
	);
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function HomeView() {
	const prefersReducedMotion = usePrefersReducedMotion();
	const reduceVisualEffects = useSettingsStore((s) => s.reduceVisualEffects);
	const reducedMotion = prefersReducedMotion || reduceVisualEffects;
	const tracks = useLibraryStore((s) => s.tracks);
	const isLibraryLoaded = useLibraryStore((s) => s.isLoaded);
	const albums = useLibraryStore((s) => s.albums);
	const artists = useLibraryStore((s) => s.artists);
	const setActiveSection = useUiStore((s) => s.setActiveSection);
	const setActiveLibraryView = useUiStore((s) => s.setActiveLibraryView);
	const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
	const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
	const isQueueOpen = useUiStore((s) => s.isQueueOpen);
	const isTrackDetailsOpen = useUiStore((s) => s.isTrackDetailsOpen);
	const setSearchOpen = useUiStore((s) => s.setSearchOpen);
	const isRightPanelOpen = isQueueOpen || isTrackDetailsOpen;

	const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		track: Track;
	} | null>(null);

	const [selectedTrackForPlaylist, setSelectedTrackForPlaylist] =
		useState<Track | null>(null);
	const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);

	const handleContextMenu = (e: React.MouseEvent, track: Track) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, track });
	};

	const getContextMenuItems = (track: Track): ContextMenuItem[] => [
		{
			label: "Play",
			icon: <Play size={14} />,
			onClick: () => {
				playTrack(track.id);
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
			onClick: () => {
				addToQueueNext(track);
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
			label: "Go to Album",
			icon: <Disc3 size={14} />,
			onClick: () => {
				const album = findTrackAlbum(albums, track);
				if (album) setSelectedAlbum(album);
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

	const [recentlyPlayed, setRecentlyPlayed] = useState<Track[]>([]);
	const [topArtists, setTopArtists] = useState<TopArtist[]>([]);
	const [recentlyAdded, setRecentlyAdded] = useState<Track[]>([]);

	const loadHistoryData = useCallback(async () => {
		const [rp, ta, ra] = await Promise.allSettled([
			getRecentlyPlayed(),
			getTopArtistsPlayed(),
			getRecentlyAddedTracks(),
		]);
		if (rp.status === "fulfilled") setRecentlyPlayed(rp.value);
		if (ta.status === "fulfilled") setTopArtists(ta.value);
		if (ra.status === "fulfilled") setRecentlyAdded(ra.value);
	}, []);

	// Full load on mount
	useEffect(() => {
		loadHistoryData();
	}, [loadHistoryData]);

	// Debounced refresh on track change — waits 400ms so rapid skipping collapses
	// into one fetch instead of hammering the DB Mutex on every next-track press.
	useEffect(() => {
		if (!currentTrackId) return;
		const timer = setTimeout(async () => {
			const [rp, ta] = await Promise.allSettled([
				getRecentlyPlayed(),
				getTopArtistsPlayed(),
			]);
			if (rp.status === "fulfilled") setRecentlyPlayed(rp.value);
			if (ta.status === "fulfilled") setTopArtists(ta.value);
		}, 400);
		return () => clearTimeout(timer);
	}, [currentTrackId]);

	const greeting = useMemo(() => {
		const h = new Date().getHours();
		if (h < 5 || h >= 22) return "Up late?";
		if (h < 12) return "Good morning";
		if (h < 17) return "Good afternoon";
		return "Good evening";
	}, []);

	const spotlightAlbum = useMemo(() => {
		if (albums.length === 0) return null;
		return albums[Math.floor(Math.random() * albums.length)];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [albums.length]);

	const recentAlbums = useMemo(
		() => [...albums].reverse().slice(0, 8),
		[albums],
	);
	const totalDurationSecs = useMemo(
		() => tracks.reduce((acc, track) => acc + track.duration_secs, 0),
		[tracks],
	);

	const handleShuffleAll = async () => {
		if (tracks.length === 0) return;
		const shuffledTracks = shuffled(tracks);
		await clearQueue();
		await playTrack(shuffledTracks[0].id);
		if (shuffledTracks.length > 1) {
			await addTracksToQueue(shuffledTracks.slice(1));
		}
	};

	const handlePlaySpotlight = async () => {
		if (!spotlightAlbum) return;
		const albumTracks = tracks.filter(
			(t) =>
				t.album === spotlightAlbum.name &&
				t.album_artist === spotlightAlbum.artist,
		);
		if (albumTracks.length === 0) return;
		await clearQueue();
		await playTrack(albumTracks[0].id);
		if (albumTracks.length > 1) {
			await addTracksToQueue(albumTracks.slice(1));
		}
	};

	const handleTrackAlbumClick = useCallback(
		(track: Track) => {
			const album = findTrackAlbum(albums, track);
			if (album) setSelectedAlbum(album);
		},
		[albums, setSelectedAlbum],
	);

	const handleTrackArtistClick = useCallback(
		(track: Track) => {
			const artist =
				artists.find((candidate) => candidate.name === track.artist) ??
				artists.find((candidate) => candidate.name === track.album_artist);
			if (artist) setSelectedArtist(artist);
		},
		[artists, setSelectedArtist],
	);

	const homeScrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const root = homeScrollRef.current;
		if (!root) return;

		const targets = root.querySelectorAll<HTMLElement>(
			".quick-actions-grid, .home-section, .home-feature",
		);
		targets.forEach((target) => target.classList.add("home-scroll-reveal"));

		if (reducedMotion) {
			targets.forEach((target) => target.classList.add("is-visible"));
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						entry.target.classList.add("is-visible");
					} else if (
						entry.rootBounds &&
						entry.boundingClientRect.top > entry.rootBounds.bottom
					) {
						entry.target.classList.remove("is-visible");
					}
				});
			},
			{ root, threshold: 0.14, rootMargin: "0px 0px -18%" },
		);

		targets.forEach((target) => observer.observe(target));

		return () => observer.disconnect();
	}, [
		reducedMotion,
		recentlyPlayed.length,
		topArtists.length,
		recentlyAdded.length,
		recentAlbums.length,
	]);

	if (!isLibraryLoaded) {
		return (
			<div className="home-scroll-wrapper">
				<div className="home-view home-loading" aria-busy="true">
					<Music size={30} />
					<span>Loading your library…</span>
				</div>
			</div>
		);
	}

	if (tracks.length === 0) {
		return (
			<div className="home-scroll-wrapper scrollbar-host">
				<div className="home-view home-empty" ref={homeScrollRef}>
					<div className="home-greeting-container">
						<div>
							<div className="home-eyebrow-row">
								<div className="home-eyebrow">Your library</div>
								<button
									className="home-search-trigger"
									onClick={() => setSearchOpen(true)}
									title="Search library"
									aria-label="Search library"
								>
									<Search size={14} />
								</button>
							</div>
							<AnimatedGreeting
								text={greeting}
								reducedMotion={reducedMotion}
							/>
						</div>
					</div>
					<div className="home-empty-state">
						<Music size={56} className="text-tertiary" />
						<h2>Your library is empty</h2>
						<p>Add some music folders to get started.</p>
					</div>
				</div>
				<CustomScrollbar scrollRef={homeScrollRef} />
			</div>
		);
	}

	return (
		<div className="home-scroll-wrapper scrollbar-host">
			<div
				className={`home-view${isRightPanelOpen ? " home-view--right-panel-open" : ""}`}
				ref={homeScrollRef}
			>
				{/* Masthead */}
				<div className="home-masthead">
					<div className="home-header">
						<div className="home-greeting-container">
							<div>
								<div className="home-eyebrow-row">
									<div className="home-eyebrow">Listen now</div>
									<button
										className="home-search-trigger"
										onClick={() => setSearchOpen(true)}
										title="Search library"
										aria-label="Search library"
									>
										<Search size={14} />
									</button>
								</div>
								<AnimatedGreeting
									text={greeting}
									reducedMotion={reducedMotion}
								/>
							</div>
						</div>
						<p className="home-intro-copy">
							Pick up where you left off, or let the next track surprise you.
						</p>
						<LibraryStats
							tracks={tracks.length}
							albums={albums.length}
							artists={artists.length}
							totalSecs={totalDurationSecs}
						/>
					</div>
				</div>

				{/* Quick Actions */}
				<div className="quick-actions-grid">
					<button className="quick-action-card" onClick={handleShuffleAll}>
						<div className="quick-action-icon">
							<Shuffle size={22} />
						</div>
						<div className="quick-action-details">
							<h3>Shuffle All</h3>
							<p>Play {tracks.length.toLocaleString()} tracks randomly</p>
						</div>
					</button>
					<button
						className="quick-action-card"
						onClick={() => {
							setActiveSection("library");
							setActiveLibraryView("songs");
						}}
					>
						<div className="quick-action-icon">
							<ListMusic size={22} />
						</div>
						<div className="quick-action-details">
							<h3>All Songs</h3>
							<p>Browse your full library</p>
						</div>
					</button>
					<button
						className="quick-action-card"
						onClick={() => {
							setActiveSection("library");
							setActiveLibraryView("artists");
						}}
					>
						<div className="quick-action-icon">
							<Mic2 size={22} />
						</div>
						<div className="quick-action-details">
							<h3>Browse Artists</h3>
							<p>{artists.length.toLocaleString()} artists in library</p>
						</div>
					</button>
				</div>

				{/* Recently Played */}
				{recentlyPlayed.length > 0 && (
					<div className="home-section home-section--recently-played">
						<div className="home-section-header">
							<h2 className="section-title">Recently played</h2>
						</div>
						<ScrollArea
							orientation="horizontal"
							controls
							className="home-track-cards-row-wrapper"
							viewportClassName="home-track-cards-row"
						>
							{recentlyPlayed.map((track) => (
								<TrackCard
									key={track.id}
					track={track}
					onContextMenu={handleContextMenu}
					onAlbumClick={handleTrackAlbumClick}
					onArtistClick={handleTrackArtistClick}
								/>
							))}
						</ScrollArea>
					</div>
				)}

				{/* Top Artists */}
				{topArtists.length > 0 && (
					<div className="home-section home-section--top-artists">
						<div className="home-section-header">
							<h2 className="section-title">Top artists</h2>
							<button
								className="home-see-all"
								onClick={() => {
									setActiveSection("library");
									setActiveLibraryView("artists");
								}}
							>
								See all <ChevronRight size={14} />
								</button>
							</div>
						<ScrollArea
							orientation="horizontal"
							controls
							className="home-track-cards-row-wrapper"
							viewportClassName="home-artist-row"
						>
							{topArtists.map((a) => (
								<ArtistCard key={a.name} artist={a} />
							))}
						</ScrollArea>
					</div>
				)}

				{/* Recently Added Tracks */}
				{recentlyAdded.length > 0 && (
					<div className="home-section home-section--recently-added">
						<div className="home-section-header">
							<h2 className="section-title">Recently added</h2>
							<button
								className="home-see-all"
								onClick={() => {
									setActiveSection("library");
									setActiveLibraryView("songs");
								}}
							>
								See all <ChevronRight size={14} />
							</button>
						</div>
						<ScrollArea
							orientation="horizontal"
							controls
							className="home-track-cards-row-wrapper"
							viewportClassName="home-track-cards-row"
						>
							{recentlyAdded.slice(0, 12).map((track) => (
								<TrackCard
									key={track.id}
					track={track}
					onContextMenu={handleContextMenu}
					onAlbumClick={handleTrackAlbumClick}
					onArtistClick={handleTrackArtistClick}
								/>
							))}
						</ScrollArea>
					</div>
				)}

				{/* Recently Added Albums */}
				{recentAlbums.length > 0 && (
					<div className="home-section home-section--recent-albums">
						<div className="home-section-header">
							<h2 className="section-title">Recent albums</h2>
							<button
								className="home-see-all"
								onClick={() => {
									setActiveSection("library");
									setActiveLibraryView("albums");
								}}
							>
								See all <ChevronRight size={14} />
							</button>
						</div>
						<div className="home-album-shelf">
							<AlbumGrid albums={recentAlbums} horizontal={true} />
						</div>
					</div>
				)}

				{/* Album Spotlight */}
				{spotlightAlbum && (
					<SpotlightCard
						album={spotlightAlbum}
						onPlay={handlePlaySpotlight}
						onNavigate={() => {
							setActiveSection("library");
							setSelectedAlbum(spotlightAlbum);
						}}
						onViewAlbums={() => {
							setActiveSection("library");
							setActiveLibraryView("albums");
						}}
					/>
				)}

			</div>
			<CustomScrollbar scrollRef={homeScrollRef} />

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

// ─── Spotlight ────────────────────────────────────────────────────────────────

function SpotlightCard({
	album,
	onPlay,
	onNavigate,
	onViewAlbums,
}: {
	album: import("../../types").Album;
	onPlay: () => void;
	onNavigate: () => void;
	onViewAlbums: () => void;
}) {
	const { artworkUrl } = useArtwork(
		album.artwork_track_id ?? "",
		`${album.name}||${album.artist}`,
		{ size: 768 },
	);
	return (
		<div className="home-feature">
			<div className="spotlight-card" onClick={onNavigate}>
				<div
					className="spotlight-bg"
					style={
						artworkUrl ? { backgroundImage: `url(${artworkUrl})` } : undefined
					}
				/>
				<div className="spotlight-art">
					{artworkUrl ? (
						<img src={artworkUrl} alt="" />
					) : (
						<Disc3 size={48} className="text-tertiary" />
					)}
				</div>
				<div className="spotlight-info">
					<div className="spotlight-label">From your collection</div>
					<div className="spotlight-title">{album.name}</div>
					<div className="spotlight-artist">
						{album.artist}
						{album.year ? ` · ${album.year}` : ""}
					</div>
					<div className="spotlight-meta">{album.track_count} tracks</div>
					<div className="spotlight-actions">
						<button
							className="spotlight-play-btn"
							onClick={(e) => {
								e.stopPropagation();
								onPlay();
							}}
						>
							<Play size={16} fill="currentColor" /> Play Album
						</button>
						<button
							className="spotlight-browse-btn"
							onClick={(e) => {
								e.stopPropagation();
								onViewAlbums();
							}}
						>
							Browse Albums
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

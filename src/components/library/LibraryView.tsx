import { Suspense, lazy, useState, useMemo, useRef, useEffect, useLayoutEffect, useDeferredValue } from "react";
import {
	Search,
	X,
	SlidersHorizontal,
	Check,
	ChevronDown,
	LayoutGrid,
	ListMusic,
	List,
	Play,
	Shuffle,
} from "lucide-react";
import { createPortal } from "react-dom";
import { isModalDialogOpen } from "../ui/dialogManager";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import { playTracks } from "../../utils/tauri";
import CustomScrollbar from "../ui/CustomScrollbar";
import { filterTracks } from "../../utils/filterTracks";
import { shouldFocusLibraryFilter } from "../../utils/shortcuts";
import "./LibraryView.css";

const SongTable = lazy(() => import("./SongTable"));
const AlbumGrid = lazy(() => import("./AlbumGrid"));
const AlbumList = lazy(() => import("./AlbumList"));
const AlbumDetails = lazy(() => import("./AlbumDetails"));
const ArtistList = lazy(() => import("./ArtistList"));
const ArtistDetails = lazy(() => import("./ArtistDetails"));
const HomeView = lazy(() => import("../home/HomeView"));

// ─── Genre filter dropdown ────────────────────────────────────────────────────

interface GenreFilterProps {
	genres: string[];
	selected: string[];
	onChange: (genres: string[]) => void;
}

function GenreFilter({ genres, selected, onChange }: GenreFilterProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({ position: 'fixed', top: -9999, left: -9999, pointerEvents: 'none', zIndex: 9999 });

	useLayoutEffect(() => {
		if (!open || !buttonRef.current || !dropdownRef.current) return;

		const updatePosition = () => {
			if (!buttonRef.current || !dropdownRef.current) return;
			const btnRect = buttonRef.current.getBoundingClientRect();
			const ddRect = dropdownRef.current.getBoundingClientRect();
			const GAP = 6;
			const VIEWPORT_GUTTER = 12;
			const spaceBelow = window.innerHeight - btnRect.bottom;
			const spaceAbove = btnRect.top;
			const openUp = spaceBelow < ddRect.height + GAP && spaceAbove > spaceBelow;
			const top = Math.max(
				VIEWPORT_GUTTER,
				openUp ? btnRect.top - ddRect.height - GAP : btnRect.bottom + GAP,
			);
			const left = Math.min(
				window.innerWidth - ddRect.width - VIEWPORT_GUTTER,
				Math.max(VIEWPORT_GUTTER, btnRect.right - ddRect.width),
			);
			setDropdownStyle({ position: 'fixed', top, left, pointerEvents: 'auto', zIndex: 9999 });
		};

		updatePosition();
		window.addEventListener('resize', updatePosition);
		window.addEventListener('scroll', updatePosition, true);
		return () => {
			window.removeEventListener('resize', updatePosition);
			window.removeEventListener('scroll', updatePosition, true);
		};
	}, [open, genres.length]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: PointerEvent) => {
			const clickedContainer = containerRef.current && containerRef.current.contains(e.target as Node);
			const clickedDropdown = dropdownRef.current && dropdownRef.current.contains(e.target as Node);
			if (!clickedContainer && !clickedDropdown) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", handler);
		return () => document.removeEventListener("pointerdown", handler);
	}, [open]);

	const toggle = (genre: string) => {
		onChange(
			selected.includes(genre)
				? selected.filter((g) => g !== genre)
				: [...selected, genre],
		);
	};

	return (
		<div className="genre-filter" ref={containerRef}>
			<button
				ref={buttonRef}
				className={`genre-filter-btn${selected.length > 0 ? " genre-filter-btn--active" : ""}`}
				onClick={() => setOpen((o) => !o)}
				title="Filter by genre"
			>
				<SlidersHorizontal size={13} />
				<span>Genre</span>
				{selected.length > 0 && (
					<span className="genre-filter-count">{selected.length}</span>
				)}
				<ChevronDown
					size={11}
					className={`genre-filter-chevron${open ? " open" : ""}`}
				/>
			</button>

			{open && createPortal(
				<div className="genre-dropdown" ref={dropdownRef} style={dropdownStyle}>
					<div className="genre-dropdown-header">
						<span className="genre-dropdown-title">Filter by Genre</span>
						{selected.length > 0 && (
							<button
								className="genre-dropdown-clear"
								onClick={() => onChange([])}
							>
								Clear all
							</button>
						)}
					</div>
					<div className="genre-dropdown-list-wrapper scrollbar-host">
						<div className="genre-dropdown-list" ref={listRef}>
							{genres.map((genre) => {
								const isSelected = selected.includes(genre);
								return (
									<button
										key={genre}
										className={`genre-option${isSelected ? " selected" : ""}`}
										onClick={() => toggle(genre)}
									>
										<span className="genre-option-check">
											{isSelected && <Check size={11} />}
										</span>
										<span className="genre-option-label">{genre}</span>
									</button>
								);
							})}
						</div>
						<CustomScrollbar scrollRef={listRef} />
					</div>
				</div>,
				document.body
			)}
		</div>
	);
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function LibraryView() {
	const activeSection = useUiStore((s) => s.activeSection);
	const activeLibraryView = useUiStore((s) => s.activeLibraryView);
	const albumViewMode = useUiStore((s) => s.albumViewMode);
	const songViewMode = useUiStore((s) => s.songViewMode);
	const selectedAlbum = useUiStore((s) => s.selectedAlbum);
	const selectedArtist = useUiStore((s) => s.selectedArtist);
	const selectedGenres = useUiStore((s) => s.selectedGenres);
	const setAlbumViewMode = useUiStore((s) => s.setAlbumViewMode);
	const setSongViewMode = useUiStore((s) => s.setSongViewMode);
	const setSelectedGenres = useUiStore((s) => s.setSelectedGenres);

	const isLibraryLoaded = useLibraryStore((s) => s.isLoaded);
	const isLibraryLoading = useLibraryStore((s) => s.isLoading);
	const libraryLoadError = useLibraryStore((s) => s.libraryLoadError);
	const tracks = useLibraryStore((s) => s.tracks);
	const albums = useLibraryStore((s) => s.albums);
	const artists = useLibraryStore((s) => s.artists);

	const [songQuery, setSongQuery] = useState("");
	const [albumQuery, setAlbumQuery] = useState("");
	const [artistQuery, setArtistQuery] = useState("");
	const deferredSongQuery = useDeferredValue(songQuery);
	const deferredAlbumQuery = useDeferredValue(albumQuery);
	const deferredArtistQuery = useDeferredValue(artistQuery);
	const searchRef = useRef<HTMLInputElement>(null);

	// Reset filters when switching tabs
	useEffect(() => {
		if (activeLibraryView !== "songs") {
			setSongQuery("");
			setSelectedGenres([]);
		}
		if (activeLibraryView !== "albums") setAlbumQuery("");
		if (activeLibraryView !== "artists") setArtistQuery("");
	}, [activeLibraryView, setSelectedGenres]);

	// Press "/" to focus search on any list view
	useEffect(() => {
		const listViews = ["songs", "albums", "artists"];
		if (!listViews.includes(activeLibraryView)) return;
		const onKey = (e: KeyboardEvent) => {
			if (
				!e.defaultPrevented &&
				!isModalDialogOpen() &&
				shouldFocusLibraryFilter(e.key, e.target, e.isComposing)
			) {
				e.preventDefault();
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [activeLibraryView]);

	// Available genres from the library (sorted, no "Unknown")
	const availableGenres = useMemo(() => {
		const seen = new Set<string>();
		for (const t of tracks) {
			if (t.genre && t.genre !== "Unknown") seen.add(t.genre);
		}
		return Array.from(seen).sort((a, b) => a.localeCompare(b));
	}, [tracks]);

	// Apply text search then genre filter
	const filteredTracks = useMemo(() => {
		let result = filterTracks(tracks, deferredSongQuery);
		if (selectedGenres.length > 0) {
			const genreSet = new Set(selectedGenres);
			result = result.filter((t) => genreSet.has(t.genre));
		}
		return result;
	}, [tracks, deferredSongQuery, selectedGenres]);

	const filteredAlbums = useMemo(() => {
		const q = deferredAlbumQuery.trim().toLowerCase();
		if (!q) return albums;
		return albums.filter(
			(a) =>
				a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q),
		);
	}, [albums, deferredAlbumQuery]);

	const filteredArtists = useMemo(() => {
		const q = deferredArtistQuery.trim().toLowerCase();
		if (!q) return artists;
		return artists.filter((a) => a.name.toLowerCase().includes(q));
	}, [artists, deferredArtistQuery]);

	const isFiltering = deferredSongQuery.trim().length > 0 || selectedGenres.length > 0;
	const isAlbumFiltering = deferredAlbumQuery.trim().length > 0;
	const isArtistFiltering = deferredArtistQuery.trim().length > 0;
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
	const viewContentRef = useMemo(() => ({ current: scrollElement }), [scrollElement]);

	const handlePlayAllSongs = async () => {
		if (filteredTracks.length === 0) return;
		try {
			await playTracks(filteredTracks.map(({ id }) => id), 0, false);
		} catch (err: any) {
			console.error("Play all songs failed:", err);
			useToastStore
				.getState()
				.addToast(`Play all failed: ${err.toString()}`, "error");
		}
	};

	const handleShuffleAllSongs = async () => {
		if (filteredTracks.length === 0) return;
		try {
			const startIndex = Math.floor(Math.random() * filteredTracks.length);
			await playTracks(
				filteredTracks.map(({ id }) => id),
				startIndex,
				true,
			);
		} catch (err: any) {
			console.error("Shuffle all songs failed:", err);
			useToastStore
				.getState()
				.addToast(`Shuffle all failed: ${err.toString()}`, "error");
		}
	};

	if (activeSection === "home") {
		return (
			<Suspense fallback={<div className="home-chunk-loading" aria-label="Loading home" />}>
				<HomeView />
			</Suspense>
		);
	}

	const sectionLabel =
		activeSection === "library"
			? activeLibraryView.charAt(0).toUpperCase() + activeLibraryView.slice(1)
			: "Playlist";

	return (
			<div className="library-view">
				<div className="view-header">
				<div className="view-header-top">
					<div className="view-header-title">
						<h1>{sectionLabel}</h1>
						{activeLibraryView === "songs" && isLibraryLoaded && (
							<span className="songs-count">
								{isFiltering
									? `${filteredTracks.length.toLocaleString()} of ${tracks.length.toLocaleString()}`
									: `${tracks.length.toLocaleString()} songs`}
							</span>
						)}
						{activeLibraryView === "albums" && isLibraryLoaded && !selectedAlbum && (
							<span className="songs-count">
								{isAlbumFiltering
									? `${filteredAlbums.length.toLocaleString()} of ${albums.length.toLocaleString()}`
									: `${albums.length.toLocaleString()} albums`}
							</span>
						)}
						{activeLibraryView === "artists" &&
							isLibraryLoaded &&
							!selectedArtist && (
								<span className="songs-count">
									{isArtistFiltering
										? `${filteredArtists.length.toLocaleString()} of ${artists.length.toLocaleString()}`
										: `${artists.length.toLocaleString()} artists`}
								</span>
							)}
					</div>
					{activeLibraryView === "songs" && isLibraryLoaded && (
						<div className="albums-header-controls">
							<div className="album-view-toggle" role="group" aria-label="Song view">
								<button
									className={`album-view-toggle-btn${songViewMode === "artwork" ? " active" : ""}`}
									onClick={() => setSongViewMode("artwork")}
									title="Artwork view"
									aria-pressed={songViewMode === "artwork"}
								>
									<ListMusic size={14} />
									<span>Artwork</span>
								</button>
								<button
									className={`album-view-toggle-btn${songViewMode === "compact" ? " active" : ""}`}
									onClick={() => setSongViewMode("compact")}
									title="Compact view"
									aria-pressed={songViewMode === "compact"}
								>
									<List size={14} />
									<span>Compact</span>
								</button>
							</div>
						</div>
					)}
					{activeLibraryView === "albums" && isLibraryLoaded && !selectedAlbum && (
						<div className="albums-header-controls">
							<div className="album-view-toggle" role="group" aria-label="Album view">
								<button
									className={`album-view-toggle-btn${albumViewMode === "grid" ? " active" : ""}`}
									onClick={() => setAlbumViewMode("grid")}
									title="Grid view"
									aria-pressed={albumViewMode === "grid"}
								>
									<LayoutGrid size={14} />
									<span>Grid</span>
								</button>
								<button
									className={`album-view-toggle-btn${albumViewMode === "list" ? " active" : ""}`}
									onClick={() => setAlbumViewMode("list")}
									title="List view"
									aria-pressed={albumViewMode === "list"}
								>
									<List size={14} />
									<span>List</span>
								</button>
							</div>
						</div>
					)}
				</div>

				{activeLibraryView === "songs" && isLibraryLoaded && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search by title, artist, album, year…"
								aria-label="Filter songs in this list"
								title="Filter songs in this list (press / to focus)"
								value={songQuery}
								onChange={(e) => setSongQuery(e.target.value)}
								spellCheck={false}
							/>
							{songQuery && (
								<button
									className="songs-search-clear"
									onClick={() => {
										setSongQuery("");
										searchRef.current?.focus();
									}}
									title="Clear search"
								>
									<X size={14} />
								</button>
							)}
						</div>

						<div className="songs-actions">
							<button
								className="btn btn-primary songs-action-btn"
								onClick={handlePlayAllSongs}
								disabled={filteredTracks.length === 0}
							>
								<Play size={16} fill="currentColor" />
								<span>Play All</span>
							</button>
							<button
								className="btn btn-ghost songs-action-btn"
								onClick={handleShuffleAllSongs}
								disabled={filteredTracks.length === 0}
							>
								<Shuffle size={16} />
								<span>Shuffle All</span>
							</button>
						</div>

						{availableGenres.length > 0 && (
							<GenreFilter
								genres={availableGenres}
								selected={selectedGenres}
								onChange={setSelectedGenres}
							/>
						)}
					</div>
				)}

				{activeLibraryView === "albums" && isLibraryLoaded && !selectedAlbum && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search by album or artist…"
								aria-label="Filter albums in this list"
								title="Filter albums in this list (press / to focus)"
								value={albumQuery}
								onChange={(e) => setAlbumQuery(e.target.value)}
								spellCheck={false}
							/>
							{albumQuery && (
								<button
									className="songs-search-clear"
									onClick={() => {
										setAlbumQuery("");
										searchRef.current?.focus();
									}}
									title="Clear search"
								>
									<X size={14} />
								</button>
							)}
						</div>
					</div>
				)}

				{activeLibraryView === "artists" && isLibraryLoaded && !selectedArtist && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search artists…"
								aria-label="Filter artists in this list"
								title="Filter artists in this list (press / to focus)"
								value={artistQuery}
								onChange={(e) => setArtistQuery(e.target.value)}
								spellCheck={false}
							/>
							{artistQuery && (
								<button
									className="songs-search-clear"
									onClick={() => {
										setArtistQuery("");
										searchRef.current?.focus();
									}}
									title="Clear search"
								>
									<X size={14} />
								</button>
							)}
						</div>
					</div>
				)}
			</div>

			<div className="view-scroll-wrapper scrollbar-host">
				<div className="view-content" ref={setScrollElement}>
					{libraryLoadError && !isLibraryLoaded ? null : isLibraryLoading && !isLibraryLoaded ? (
						<div className="empty-state" role="status" aria-live="polite">
							<h3>Loading your library…</h3>
						</div>
					) : activeLibraryView === "songs" ? (
						filteredTracks.length === 0 && isFiltering ? (
							<div className="empty-state">
								{selectedGenres.length > 0 && !deferredSongQuery ? (
									<p>
										No songs in <strong>{selectedGenres.join(", ")}</strong>
									</p>
								) : (
									<p>
										No songs match <strong>"{deferredSongQuery}"</strong>
										{selectedGenres.length > 0
											? ` in ${selectedGenres.join(", ")}`
											: ""}
									</p>
								)}
							</div>
						) : (
							<Suspense fallback={null}>
								<SongTable
									key={songViewMode}
									tracks={filteredTracks}
									isLibraryEmpty={tracks.length === 0}
									hideArtwork={songViewMode === "compact"}
									compact={songViewMode === "compact"}
									scrollRef={viewContentRef}
								/>
							</Suspense>
						)
					) : activeLibraryView === "albums" ? (
						selectedAlbum ? (
							<Suspense fallback={null}>
								<AlbumDetails scrollRef={viewContentRef} />
							</Suspense>
						) : filteredAlbums.length === 0 && isAlbumFiltering ? (
							<div className="empty-state">
							<p>
								No albums match <strong>"{deferredAlbumQuery}"</strong>
							</p>
						</div>
						) : albumViewMode === "list" ? (
							<Suspense fallback={null}>
								<AlbumList albums={filteredAlbums} scrollRef={viewContentRef} />
							</Suspense>
						) : (
							<Suspense fallback={null}>
								<AlbumGrid albums={filteredAlbums} scrollRef={viewContentRef} />
							</Suspense>
						)
					) : activeLibraryView === "artists" ? (
						selectedArtist ? (
							<Suspense fallback={null}>
								<ArtistDetails scrollRef={viewContentRef} />
							</Suspense>
						) : filteredArtists.length === 0 && isArtistFiltering ? (
							<div className="empty-state">
								<p>
									No artists match <strong>"{deferredArtistQuery}"</strong>
								</p>
							</div>
						) : (
							<Suspense fallback={null}>
								<ArtistList
									artists={filteredArtists}
									scrollRef={viewContentRef}
								/>
							</Suspense>
						)
					) : (
						<div className="empty-state">
							<h3>Coming Soon</h3>
							<p>The {activeLibraryView} view is under construction.</p>
						</div>
					)}
				</div>
				<CustomScrollbar scrollRef={viewContentRef} />
			</div>
		</div>
	);
}

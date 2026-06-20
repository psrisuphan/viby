import { useState, useMemo, useRef, useEffect } from "react";
import {
	Search,
	X,
	SlidersHorizontal,
	Check,
	ChevronDown,
	LayoutGrid,
	List,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import SongTable from "./SongTable";
import AlbumGrid from "./AlbumGrid";
import AlbumList from "./AlbumList";
import AlbumDetails from "./AlbumDetails";
import ArtistList from "./ArtistList";
import ArtistDetails from "./ArtistDetails";
import HomeView from "../home/HomeView";
import CustomScrollbar from "../ui/CustomScrollbar";
import { filterTracks } from "../../utils/filterTracks";
import "./LibraryView.css";

// ─── Genre filter dropdown ────────────────────────────────────────────────────

interface GenreFilterProps {
	genres: string[];
	selected: string[];
	onChange: (genres: string[]) => void;
}

function GenreFilter({ genres, selected, onChange }: GenreFilterProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: PointerEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
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

			{open && (
				<div className="genre-dropdown">
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
				</div>
			)}
		</div>
	);
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function LibraryView() {
	const activeSection = useUiStore((s) => s.activeSection);
	const activeLibraryView = useUiStore((s) => s.activeLibraryView);
	const albumViewMode = useUiStore((s) => s.albumViewMode);
	const selectedAlbum = useUiStore((s) => s.selectedAlbum);
	const selectedArtist = useUiStore((s) => s.selectedArtist);
	const selectedGenres = useUiStore((s) => s.selectedGenres);
	const setAlbumViewMode = useUiStore((s) => s.setAlbumViewMode);
	const setSelectedGenres = useUiStore((s) => s.setSelectedGenres);

	const isScanning = useLibraryStore((s) => s.isScanning);
	const scanProgress = useLibraryStore((s) => s.scanProgress);
	const scanStatusText = useLibraryStore((s) => s.scanStatusText);
	const tracks = useLibraryStore((s) => s.tracks);
	const albums = useLibraryStore((s) => s.albums);
	const artists = useLibraryStore((s) => s.artists);

	const [songQuery, setSongQuery] = useState("");
	const [albumQuery, setAlbumQuery] = useState("");
	const [artistQuery, setArtistQuery] = useState("");
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
			if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
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
		let result = filterTracks(tracks, songQuery);
		if (selectedGenres.length > 0) {
			const genreSet = new Set(selectedGenres);
			result = result.filter((t) => genreSet.has(t.genre));
		}
		return result;
	}, [tracks, songQuery, selectedGenres]);

	const filteredAlbums = useMemo(() => {
		const q = albumQuery.trim().toLowerCase();
		if (!q) return albums;
		return albums.filter(
			(a) =>
				a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q),
		);
	}, [albums, albumQuery]);

	const filteredArtists = useMemo(() => {
		const q = artistQuery.trim().toLowerCase();
		if (!q) return artists;
		return artists.filter((a) => a.name.toLowerCase().includes(q));
	}, [artists, artistQuery]);

	const isFiltering = songQuery.trim().length > 0 || selectedGenres.length > 0;
	const viewContentRef = useRef<HTMLDivElement>(null);

	if (activeSection === "home") {
		return <HomeView />;
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
						{activeLibraryView === "songs" && !isScanning && (
							<span className="songs-count">
								{isFiltering
									? `${filteredTracks.length.toLocaleString()} of ${tracks.length.toLocaleString()}`
									: `${tracks.length.toLocaleString()} songs`}
							</span>
						)}
						{activeLibraryView === "albums" && !isScanning && !selectedAlbum && (
							<span className="songs-count">
								{albumQuery.trim()
									? `${filteredAlbums.length.toLocaleString()} of ${albums.length.toLocaleString()}`
									: `${albums.length.toLocaleString()} albums`}
							</span>
						)}
						{activeLibraryView === "artists" &&
							!isScanning &&
							!selectedArtist && (
								<span className="songs-count">
									{artistQuery.trim()
										? `${filteredArtists.length.toLocaleString()} of ${artists.length.toLocaleString()}`
										: `${artists.length.toLocaleString()} artists`}
								</span>
							)}
					</div>
					{activeLibraryView === "albums" && !isScanning && !selectedAlbum && (
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

				{activeLibraryView === "songs" && !isScanning && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search by title, artist, album, year…"
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

						{availableGenres.length > 0 && (
							<GenreFilter
								genres={availableGenres}
								selected={selectedGenres}
								onChange={setSelectedGenres}
							/>
						)}
					</div>
				)}

				{activeLibraryView === "albums" && !isScanning && !selectedAlbum && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search by album or artist…"
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

				{activeLibraryView === "artists" && !isScanning && !selectedArtist && (
					<div className="songs-controls">
						<div className="songs-search-bar">
							<Search size={15} className="songs-search-icon" />
							<input
								ref={searchRef}
								className="songs-search-input"
								type="text"
								placeholder="Search artists…"
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
				<div className="view-content" ref={viewContentRef}>
					{isScanning ? (
						<div className="empty-state">
							<div className="scanning-indicator">
								<div className="spinner animate-spin"></div>
								<h3>Scanning Library...</h3>
							</div>
							<p>{scanStatusText}</p>
							<div className="progress-bar-container">
								<div
									className="progress-bar-fill"
									style={{ width: `${scanProgress}%` }}
								></div>
							</div>
						</div>
					) : activeLibraryView === "songs" ? (
						filteredTracks.length === 0 && isFiltering ? (
							<div className="empty-state">
								{selectedGenres.length > 0 && !songQuery ? (
									<p>
										No songs in <strong>{selectedGenres.join(", ")}</strong>
									</p>
								) : (
									<p>
										No songs match <strong>"{songQuery}"</strong>
										{selectedGenres.length > 0
											? ` in ${selectedGenres.join(", ")}`
											: ""}
									</p>
								)}
							</div>
						) : (
							<SongTable tracks={filteredTracks} scrollRef={viewContentRef} />
						)
					) : activeLibraryView === "albums" ? (
						selectedAlbum ? (
							<AlbumDetails scrollRef={viewContentRef} />
						) : filteredAlbums.length === 0 && albumQuery.trim() ? (
							<div className="empty-state">
							<p>
								No albums match <strong>"{albumQuery}"</strong>
							</p>
						</div>
						) : albumViewMode === "list" ? (
							<AlbumList albums={filteredAlbums} scrollRef={viewContentRef} />
						) : (
							<AlbumGrid albums={filteredAlbums} scrollRef={viewContentRef} />
						)
					) : activeLibraryView === "artists" ? (
						selectedArtist ? (
							<ArtistDetails scrollRef={viewContentRef} />
						) : filteredArtists.length === 0 && artistQuery.trim() ? (
							<div className="empty-state">
								<p>
									No artists match <strong>"{artistQuery}"</strong>
								</p>
							</div>
						) : (
							<ArtistList
								artists={filteredArtists}
								scrollRef={viewContentRef}
							/>
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

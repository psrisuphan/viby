import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, SlidersHorizontal, Check, ChevronDown } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import SongTable from './SongTable';
import AlbumGrid from './AlbumGrid';
import AlbumDetails from './AlbumDetails';
import ArtistList from './ArtistList';
import ArtistDetails from './ArtistDetails';
import HomeView from '../home/HomeView';
import { filterTracks } from '../../utils/filterTracks';
import './LibraryView.css';

// ─── Genre filter dropdown ────────────────────────────────────────────────────

interface GenreFilterProps {
  genres: string[];
  selected: string[];
  onChange: (genres: string[]) => void;
}

function GenreFilter({ genres, selected, onChange }: GenreFilterProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (genre: string) => {
    onChange(
      selected.includes(genre)
        ? selected.filter(g => g !== genre)
        : [...selected, genre]
    );
  };

  return (
    <div className="genre-filter" ref={containerRef}>
      <button
        className={`genre-filter-btn${selected.length > 0 ? ' genre-filter-btn--active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Filter by genre"
      >
        <SlidersHorizontal size={13} />
        <span>Genre</span>
        {selected.length > 0 && (
          <span className="genre-filter-count">{selected.length}</span>
        )}
        <ChevronDown size={11} className={`genre-filter-chevron${open ? ' open' : ''}`} />
      </button>

      {open && (
        <div className="genre-dropdown">
          <div className="genre-dropdown-header">
            <span className="genre-dropdown-title">Filter by Genre</span>
            {selected.length > 0 && (
              <button className="genre-dropdown-clear" onClick={() => onChange([])}>
                Clear all
              </button>
            )}
          </div>
          <div className="genre-dropdown-list">
            {genres.map(genre => {
              const isSelected = selected.includes(genre);
              return (
                <button
                  key={genre}
                  className={`genre-option${isSelected ? ' selected' : ''}`}
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
        </div>
      )}
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function LibraryView() {
  const { activeSection, activeLibraryView, selectedAlbum, selectedArtist } = useUiStore();
  const { isScanning, scanProgress, scanStatusText, tracks, albums, artists } = useLibraryStore();

  const [songQuery, setSongQuery] = useState('');
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset filters when leaving the songs tab
  useEffect(() => {
    if (activeLibraryView !== 'songs') {
      setSongQuery('');
      setSelectedGenres([]);
    }
  }, [activeLibraryView]);

  // Press "/" to focus search when on songs view
  useEffect(() => {
    if (activeLibraryView !== 'songs') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeLibraryView]);

  // Available genres from the library (sorted, no "Unknown")
  const availableGenres = useMemo(() => {
    const seen = new Set<string>();
    for (const t of tracks) {
      if (t.genre && t.genre !== 'Unknown') seen.add(t.genre);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [tracks]);

  // Apply text search then genre filter
  const filteredTracks = useMemo(() => {
    let result = filterTracks(tracks, songQuery);
    if (selectedGenres.length > 0) {
      const genreSet = new Set(selectedGenres);
      result = result.filter(t => genreSet.has(t.genre));
    }
    return result;
  }, [tracks, songQuery, selectedGenres]);

  const isFiltering = songQuery.trim().length > 0 || selectedGenres.length > 0;
  const viewContentRef = useRef<HTMLDivElement>(null);

  if (activeSection === 'home') {
    return <HomeView />;
  }

  const sectionLabel =
    activeSection === 'library'
      ? activeLibraryView.charAt(0).toUpperCase() + activeLibraryView.slice(1)
      : 'Playlist';

  return (
    <div className="library-view">
      <div className="view-header">
        <div className="view-header-top">
          <h1>{sectionLabel}</h1>
          {activeLibraryView === 'songs' && !isScanning && (
            <span className="songs-count">
              {isFiltering
                ? `${filteredTracks.length.toLocaleString()} of ${tracks.length.toLocaleString()}`
                : `${tracks.length.toLocaleString()} songs`}
            </span>
          )}
        </div>

        {activeLibraryView === 'songs' && !isScanning && (
          <div className="songs-controls">
            <div className="songs-search-bar">
              <Search size={15} className="songs-search-icon" />
              <input
                ref={searchRef}
                className="songs-search-input"
                type="text"
                placeholder="Search by title, artist, album, year…"
                value={songQuery}
                onChange={e => setSongQuery(e.target.value)}
                spellCheck={false}
              />
              {songQuery && (
                <button
                  className="songs-search-clear"
                  onClick={() => { setSongQuery(''); searchRef.current?.focus(); }}
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
      </div>

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
        ) : activeLibraryView === 'songs' ? (
          filteredTracks.length === 0 && isFiltering ? (
            <div className="empty-state">
              {selectedGenres.length > 0 && !songQuery ? (
                <p>No songs in <strong>{selectedGenres.join(', ')}</strong></p>
              ) : (
                <p>No songs match <strong>"{songQuery}"</strong>{selectedGenres.length > 0 ? ` in ${selectedGenres.join(', ')}` : ''}</p>
              )}
            </div>
          ) : (
            <SongTable tracks={filteredTracks} />
          )
        ) : activeLibraryView === 'albums' ? (
          selectedAlbum ? <AlbumDetails scrollRef={viewContentRef} /> : <AlbumGrid albums={albums} scrollRef={viewContentRef} />
        ) : activeLibraryView === 'artists' ? (
          selectedArtist ? <ArtistDetails scrollRef={viewContentRef} /> : <ArtistList artists={artists} scrollRef={viewContentRef} />
        ) : (
          <div className="empty-state">
            <h3>Coming Soon</h3>
            <p>The {activeLibraryView} view is under construction.</p>
          </div>
        )}
      </div>
    </div>
  );
}

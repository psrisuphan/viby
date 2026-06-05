import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
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

export default function LibraryView() {
  const { activeSection, activeLibraryView, selectedAlbum, selectedArtist } = useUiStore();
  const { isScanning, scanProgress, scanStatusText, tracks, albums, artists } = useLibraryStore();

  const [songQuery, setSongQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset query when leaving the songs tab
  useEffect(() => {
    if (activeLibraryView !== 'songs') setSongQuery('');
  }, [activeLibraryView]);

  // Press "/" to focus the search bar when on songs view
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

  const filteredTracks = useMemo(
    () => filterTracks(tracks, songQuery),
    [tracks, songQuery]
  );

  const isFiltering = songQuery.trim().length > 0;

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
          <div className="songs-search-bar">
            <Search size={15} className="songs-search-icon" />
            <input
              ref={searchRef}
              className="songs-search-input"
              type="text"
              placeholder="Search by title, artist, album, genre, year…"
              value={songQuery}
              onChange={e => setSongQuery(e.target.value)}
              spellCheck={false}
            />
            {isFiltering && (
              <button
                className="songs-search-clear"
                onClick={() => { setSongQuery(''); searchRef.current?.focus(); }}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="view-content">
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
              <p>No songs match <strong>"{songQuery}"</strong></p>
            </div>
          ) : (
            <SongTable tracks={filteredTracks} />
          )
        ) : activeLibraryView === 'albums' ? (
          selectedAlbum ? <AlbumDetails /> : <AlbumGrid albums={albums} />
        ) : activeLibraryView === 'artists' ? (
          selectedArtist ? <ArtistDetails /> : <ArtistList artists={artists} />
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

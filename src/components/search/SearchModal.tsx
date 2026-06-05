import { useEffect, useRef, useState } from 'react';
import { Search, X, Play } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { searchLibrary, playTrack } from '../../utils/tauri';
import type { SearchResults } from '../../types';
import './SearchModal.css';

export default function SearchModal() {
  const { setSearchOpen } = useUiStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    // Focus input on mount
    inputRef.current?.focus();

    // Close on Escape
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  const handlePlaySong = async (path: string) => {
    await playTrack(path);
    setSearchOpen(false);
  };

  return (
    <div className="modal-overlay animate-fade-in" onClick={() => setSearchOpen(false)}>
      <div 
        className="search-modal animate-scale-in glass-panel-heavy" 
        onClick={e => e.stopPropagation()}
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
        
        <div className="search-results">
          {isSearching ? (
            <div className="empty-state">
              <div className="spinner animate-spin"></div>
              <p>Searching...</p>
            </div>
          ) : !results && !query ? (
            <div className="empty-state">
              <p>Type to start searching your library</p>
            </div>
          ) : results && (results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0) ? (
            <div className="empty-state">
              <p>No results found for "{query}"</p>
            </div>
          ) : results ? (
            <div className="search-sections">
              {results.tracks.length > 0 && (
                <div className="search-section">
                  <h3>Songs</h3>
                  <div className="search-list">
                    {results.tracks.slice(0, 5).map(track => (
                      <div key={track.id} className="search-item" onDoubleClick={() => handlePlaySong(track.file_path)}>
                        <button className="search-item-play" onClick={() => handlePlaySong(track.file_path)}>
                          <Play size={14} className="play-icon-offset" />
                        </button>
                        <div className="search-item-info">
                          <div className="search-item-title truncate">{track.title}</div>
                          <div className="search-item-subtitle truncate">{track.artist}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {results.albums.length > 0 && (
                <div className="search-section">
                  <h3>Albums</h3>
                  <div className="search-list">
                    {results.albums.slice(0, 3).map((album, i) => (
                      <div key={`album-${i}`} className="search-item">
                        <div className="search-item-info">
                          <div className="search-item-title truncate">{album.name}</div>
                          <div className="search-item-subtitle truncate">{album.artist} • {album.track_count} tracks</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {results.artists.length > 0 && (
                <div className="search-section">
                  <h3>Artists</h3>
                  <div className="search-list">
                    {results.artists.slice(0, 3).map((artist, i) => (
                      <div key={`artist-${i}`} className="search-item">
                        <div className="search-item-info">
                          <div className="search-item-title truncate">{artist.name}</div>
                          <div className="search-item-subtitle truncate">{artist.album_count} albums • {artist.track_count} tracks</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

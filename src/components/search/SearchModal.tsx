import { useEffect, useRef, useState } from 'react';
import { Search, X, Play, Music, Disc, Mic2 } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { searchLibrary, playTrack } from '../../utils/tauri';
import { useArtwork } from '../../utils/useArtwork';
import type { SearchResults, Album, Artist, Track } from '../../types';
import './SearchModal.css';

function SearchTrackItem({ track, onPlay }: { track: Track; onPlay: (id: string) => void }) {
  const { artworkUrl } = useArtwork(track.id, `${track.album}||${track.album_artist}`);

  return (
    <div className="search-item search-track-item" onDoubleClick={() => onPlay(track.id)}>
      <div className="search-item-artwork-container">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="search-item-artwork" />
        ) : (
          <div className="search-item-artwork-placeholder">
            <Music size={16} />
          </div>
        )}
        <button className="search-item-play" onClick={() => onPlay(track.id)}>
          <Play size={14} fill="currentColor" style={{ marginLeft: '1.5px' }} />
        </button>
      </div>
      <div className="search-item-info">
        <div className="search-item-title truncate">{track.title}</div>
        <div className="search-item-subtitle truncate">{track.artist} • {track.album}</div>
      </div>
    </div>
  );
}

function SearchAlbumItem({ album, onClick }: { album: Album; onClick: () => void }) {
  const { artworkUrl } = useArtwork(album.artwork_track_id, `${album.name}||${album.artist}`);

  return (
    <div className="search-item search-album-item" onClick={onClick}>
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
        <div className="search-item-subtitle truncate">{album.artist} • {album.track_count} tracks</div>
      </div>
    </div>
  );
}

function SearchArtistItem({ artist, onClick }: { artist: Artist; onClick: () => void }) {
  const albums = useLibraryStore(s => s.albums);
  // Find the first album of this artist that has artwork
  const artistAlbums = albums.filter(a => a.artist === artist.name);
  const albumWithArt = artistAlbums.find(a => a.artwork_track_id);
  const albumWithArtId = albumWithArt ? albumWithArt.artwork_track_id : null;
  
  const { artworkUrl } = useArtwork(albumWithArtId);

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
        <div className="search-item-subtitle truncate">{artist.album_count} albums • {artist.track_count} tracks</div>
      </div>
    </div>
  );
}

export default function SearchModal() {
  const {
    setSearchOpen,
    setActiveSection,
    setActiveLibraryView,
    setSelectedAlbum,
    setSelectedArtist,
  } = useUiStore();
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

  const handlePlaySong = async (trackId: string) => {
    await playTrack(trackId);
    setSearchOpen(false);
  };

  const handleAlbumClick = (album: Album) => {
    setActiveSection('library');
    setActiveLibraryView('albums');
    setSelectedAlbum(album);
    setSearchOpen(false);
  };

  const handleArtistClick = (artist: Artist) => {
    setActiveSection('library');
    setActiveLibraryView('artists');
    setSelectedArtist(artist);
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
                      <SearchTrackItem key={track.id} track={track} onPlay={handlePlaySong} />
                    ))}
                  </div>
                </div>
              )}
              
              {results.albums.length > 0 && (
                <div className="search-section">
                  <h3>Albums</h3>
                  <div className="search-list">
                    {results.albums.slice(0, 3).map((album, i) => (
                      <SearchAlbumItem key={`album-${i}`} album={album} onClick={() => handleAlbumClick(album)} />
                    ))}
                  </div>
                </div>
              )}

              {results.artists.length > 0 && (
                <div className="search-section">
                  <h3>Artists</h3>
                  <div className="search-list">
                    {results.artists.slice(0, 3).map((artist, i) => (
                      <SearchArtistItem key={`artist-${i}`} artist={artist} onClick={() => handleArtistClick(artist)} />
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

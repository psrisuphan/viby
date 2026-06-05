import type { Album } from '../../types';
import { Disc } from 'lucide-react';
import { useArtwork } from '../../utils/useArtwork';
import { useUiStore } from '../../stores/uiStore';
import './AlbumGrid.css';

interface AlbumGridProps {
  albums: Album[];
}

function AlbumCard({ album, onClick }: { album: Album; onClick?: () => void }) {
  const { artworkUrl, isLoading } = useArtwork(album.artwork_track_id);

  return (
    <div className="album-card group" onClick={onClick}>
      <div className="album-art-container">
        {artworkUrl ? (
          <img 
            src={artworkUrl} 
            alt={album.name} 
            className="album-art-image"
          />
        ) : (
          <div className="album-art-placeholder">
            <Disc size={48} className={`text-tertiary ${!isLoading ? 'group-hover:scale-110 transition-transform duration-300' : 'animate-pulse'}`} />
          </div>
        )}
        <div className="album-hover-overlay">
          <button className="play-album-btn" onClick={(e) => { e.stopPropagation(); /* play album */ }}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>
      </div>
      <div className="album-info">
        <h3 className="album-title truncate" title={album.name}>{album.name}</h3>
        <p className="album-artist truncate" title={album.artist}>{album.artist}</p>
      </div>
    </div>
  );
}

export default function AlbumGrid({ albums }: AlbumGridProps) {
  const { setSelectedAlbum } = useUiStore();

  if (albums.length === 0) {
    return (
      <div className="empty-state">
        <p>No albums found in your library.</p>
      </div>
    );
  }

  return (
    <div className="album-grid">
      {albums.map((album, idx) => (
        <AlbumCard 
          key={`${album.name}-${album.artist}-${idx}`} 
          album={album} 
          onClick={() => setSelectedAlbum(album)}
        />
      ))}
    </div>
  );
}

import type { Album } from '../../types';
import { Disc } from 'lucide-react';
import './AlbumGrid.css';

interface AlbumGridProps {
  albums: Album[];
}

export default function AlbumGrid({ albums }: AlbumGridProps) {
  // In a real app we'd load artwork asynchronously and cache it
  
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
        <div key={`${album.name}-${album.artist}-${idx}`} className="album-card group">
          <div className="album-art-container">
            {/* Placeholder for actual artwork loading */}
            <div className="album-art-placeholder">
              <Disc size={48} className="text-tertiary group-hover:scale-110 transition-transform duration-300" />
            </div>
            <div className="album-hover-overlay">
              <button className="play-album-btn">
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
      ))}
    </div>
  );
}

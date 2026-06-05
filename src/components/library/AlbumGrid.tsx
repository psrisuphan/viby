import type { Album } from '../../types';
import { Disc } from 'lucide-react';
import { useArtwork } from '../../utils/useArtwork';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { useToastStore } from '../../stores/toastStore';
import { playTrack, clearQueue, addToQueue } from '../../utils/tauri';
import './AlbumGrid.css';

interface AlbumGridProps {
  albums: Album[];
}

function AlbumCard({ album, onClick }: { album: Album; onClick?: () => void }) {
  const { artworkUrl, isLoading } = useArtwork(album.artwork_track_id);
  const { tracks } = useLibraryStore();

  const handlePlayAlbum = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    const albumTracks = tracks
      .filter(t => t.album === album.name && t.album_artist === album.artist)
      .sort((a, b) => {
        if (a.disc_number !== b.disc_number) {
          return (a.disc_number || 1) - (b.disc_number || 1);
        }
        return (a.track_number || 0) - (b.track_number || 0);
      });
      
    if (albumTracks.length === 0) return;
    
    try {
      await clearQueue();
      await playTrack(albumTracks[0].file_path);
      
      const addRestToQueue = async () => {
        for (let i = 1; i < albumTracks.length; i++) {
          try {
            await addToQueue(albumTracks[i]);
          } catch (err) {
            console.error("Failed to add track to queue", err);
          }
        }
      };
      
      addRestToQueue();
    } catch (err: any) {
      console.error("Play album failed:", err);
      useToastStore.getState().addToast(`Play album failed: ${err.toString()}`, 'error');
    }
  };

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
          <button className="play-album-btn" onClick={handlePlayAlbum}>
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

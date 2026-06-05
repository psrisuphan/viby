import { Mic2 } from 'lucide-react';
import type { Artist } from '../../types';
import { useUiStore } from '../../stores/uiStore';
import './ArtistList.css';

interface ArtistListProps {
  artists: Artist[];
}

export default function ArtistList({ artists }: ArtistListProps) {
  const { setSelectedArtist } = useUiStore();

  if (artists.length === 0) {
    return (
      <div className="empty-state">
        <p>No artists found in your library.</p>
      </div>
    );
  }

  return (
    <div className="artist-list">
      {artists.map((artist, idx) => (
        <div 
          key={`${artist.name}-${idx}`} 
          className="artist-row"
          onClick={() => setSelectedArtist(artist)}
        >
          <div className="artist-avatar">
            <Mic2 size={24} className="text-tertiary" />
          </div>
          <div className="artist-info">
            <h3 className="artist-name">{artist.name}</h3>
            <p className="artist-stats">
              {artist.album_count} {artist.album_count === 1 ? 'album' : 'albums'} • {artist.track_count} {artist.track_count === 1 ? 'song' : 'songs'}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

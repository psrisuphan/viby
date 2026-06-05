import { useMemo } from 'react';
import { Mic2 } from 'lucide-react';
import type { Artist } from '../../types';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { useArtwork } from '../../utils/useArtwork';
import './ArtistList.css';

interface ArtistListProps {
  artists: Artist[];
}

function ArtistRow({ artist, onClick }: { artist: Artist; onClick: () => void }) {
  const { albums } = useLibraryStore();
  
  const albumWithArtId = useMemo(() => {
    const artistAlbums = albums.filter(a => a.artist === artist.name);
    const albumWithArt = artistAlbums.find(a => a.artwork_track_id);
    return albumWithArt ? albumWithArt.artwork_track_id : null;
  }, [albums, artist.name]);

  const { artworkUrl } = useArtwork(albumWithArtId);

  return (
    <div className="artist-row" onClick={onClick}>
      <div className="artist-avatar">
        {artworkUrl ? (
          <img src={artworkUrl} alt={artist.name} className="artist-list-img" />
        ) : (
          <Mic2 size={24} className="text-tertiary" />
        )}
      </div>
      <div className="artist-info">
        <h3 className="artist-name">{artist.name}</h3>
        <p className="artist-stats">
          {artist.album_count} {artist.album_count === 1 ? 'album' : 'albums'} • {artist.track_count} {artist.track_count === 1 ? 'song' : 'songs'}
        </p>
      </div>
    </div>
  );
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
        <ArtistRow 
          key={`${artist.name}-${idx}`} 
          artist={artist} 
          onClick={() => setSelectedArtist(artist)}
        />
      ))}
    </div>
  );
}

import { useMemo } from 'react';
import { Play, ArrowLeft, Mic2 } from 'lucide-react';
import { useLibraryStore } from '../../stores/libraryStore';
import { useUiStore } from '../../stores/uiStore';
import { playQueueIndex, clearQueue, addToQueue } from '../../utils/tauri';
import SongTable from './SongTable';
import AlbumGrid from './AlbumGrid';
import './ArtistDetails.css';

export default function ArtistDetails() {
  const { selectedArtist, setSelectedArtist } = useUiStore();
  const { tracks, albums } = useLibraryStore();

  const artistTracks = useMemo(() => {
    if (!selectedArtist) return [];
    
    // Sort by album year, then album name, then disc, then track
    return tracks
      .filter(t => t.album_artist === selectedArtist.name || t.artist === selectedArtist.name)
      .sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0); // Newest first
        if (a.album !== b.album) return a.album.localeCompare(b.album);
        if (a.disc_number !== b.disc_number) return (a.disc_number || 1) - (b.disc_number || 1);
        return (a.track_number || 0) - (b.track_number || 0);
      });
  }, [tracks, selectedArtist]);

  const artistAlbums = useMemo(() => {
    if (!selectedArtist) return [];
    return albums.filter(a => a.artist === selectedArtist.name).sort((a, b) => (b.year || 0) - (a.year || 0));
  }, [albums, selectedArtist]);

  if (!selectedArtist) return null;

  const handlePlayAll = async () => {
    if (artistTracks.length === 0) return;
    
    // Clear queue and add all tracks
    await clearQueue();
    for (const track of artistTracks) {
      await addToQueue(track);
    }
    // Start playing the first track
    await playQueueIndex(0);
  };

  const totalDuration = useMemo(() => {
    const totalSecs = artistTracks.reduce((acc, t) => acc + t.duration_secs, 0);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    if (hours > 0) return `${hours} hr ${mins} min`;
    return `${mins} min`;
  }, [artistTracks]);

  return (
    <div className="artist-details animate-fade-in">
      <button className="back-btn" onClick={() => setSelectedArtist(null)}>
        <ArrowLeft size={20} />
        <span>Back to Artists</span>
      </button>

      <div className="artist-details-header">
        <div className="artist-details-avatar">
          <Mic2 size={64} className="text-tertiary" />
        </div>
        
        <div className="artist-details-info">
          <span className="artist-details-type">Artist</span>
          <h1 className="artist-details-title">{selectedArtist.name}</h1>
          
          <div className="artist-details-meta">
            <span>{artistAlbums.length} albums</span>
            <span className="meta-separator">•</span>
            <span>{artistTracks.length} songs, {totalDuration}</span>
          </div>

          <div className="artist-details-actions">
            <button className="btn btn-primary" onClick={handlePlayAll}>
              <Play size={20} fill="currentColor" className="play-icon-offset" />
              Play All
            </button>
          </div>
        </div>
      </div>

      {artistAlbums.length > 0 && (
        <div className="artist-section">
          <h2>Albums</h2>
          <div className="artist-albums-grid-container">
            <AlbumGrid albums={artistAlbums} />
          </div>
        </div>
      )}

      <div className="artist-section">
        <h2>All Songs</h2>
        <SongTable tracks={artistTracks} />
      </div>
    </div>
  );
}

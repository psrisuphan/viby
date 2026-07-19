import { useMemo, type RefObject } from 'react';
import { Play, Shuffle, ArrowLeft, Mic2 } from 'lucide-react';
import { useLibraryStore } from '../../stores/libraryStore';
import { useUiStore } from '../../stores/uiStore';
import { playTrack, clearQueue, addTracksToQueue } from '../../utils/tauri';
import { shuffled } from '../../utils/randomize';
import { useArtwork } from '../../utils/useArtwork';
import SongTable from './SongTable';
import AlbumGrid from './AlbumGrid';
import './ArtistDetails.css';

export default function ArtistDetails({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const selectedArtist = useUiStore((s) => s.selectedArtist);
  const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
  const tracks = useLibraryStore((s) => s.tracks);
  const albums = useLibraryStore((s) => s.albums);

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

  const albumWithArtId = useMemo(() => {
    const albumWithArt = artistAlbums.find(a => a.artwork_track_id);
    return albumWithArt ? albumWithArt.artwork_track_id : null;
  }, [artistAlbums]);

  const { artworkUrl } = useArtwork(albumWithArtId);

  if (!selectedArtist) return null;

  const handlePlayAll = async () => {
    if (artistTracks.length === 0) return;
    await clearQueue();
    await playTrack(artistTracks[0].id);
    if (artistTracks.length > 1) await addTracksToQueue(artistTracks.slice(1));
  };

  const handleShuffle = async () => {
    if (artistTracks.length === 0) return;
    const shuffledTracks = shuffled(artistTracks);
    await clearQueue();
    await playTrack(shuffledTracks[0].id);
    if (shuffledTracks.length > 1) await addTracksToQueue(shuffledTracks.slice(1));
  };

  const totalDuration = useMemo(() => {
    const totalSecs = artistTracks.reduce((acc, t) => acc + t.duration_secs, 0);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.round((totalSecs % 3600) / 60);
    if (hours > 0) return `${hours} hr ${mins} min`;
    return `${mins} min`;
  }, [artistTracks]);

  return (
    <div className="artist-details animate-fade-in">
      {artworkUrl && (
        <div className="artist-backdrop">
          <img src={artworkUrl} alt="" className="artist-backdrop-img" />
          <div className="artist-backdrop-overlay"></div>
        </div>
      )}

      <div className="artist-content-wrapper">
        <button className="back-btn" onClick={() => setSelectedArtist(null)}>
          <ArrowLeft size={20} />
          <span>Back to Artists</span>
        </button>

        <div className="artist-details-header">
          <div className="artist-details-avatar">
            {artworkUrl ? (
              <img src={artworkUrl} alt={selectedArtist.name} className="artist-avatar-img" />
            ) : (
              <Mic2 size={64} className="text-tertiary" />
            )}
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
              <button className="btn btn-ghost" onClick={handleShuffle}>
                <Shuffle size={20} />
                Shuffle
              </button>
            </div>
          </div>
        </div>

        {artistAlbums.length > 0 && (
          <div className="artist-section">
            <h2>Albums</h2>
            <div className="artist-albums-grid-container">
              <AlbumGrid albums={artistAlbums} scrollRef={scrollRef} />
            </div>
          </div>
        )}

        <div className="artist-section">
          <h2>All Songs</h2>
          <SongTable tracks={artistTracks} scrollRef={scrollRef} />
        </div>
      </div>
    </div>
  );
}

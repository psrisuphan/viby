import { useMemo, type RefObject } from 'react';
import { Play, ArrowLeft, Disc } from 'lucide-react';
import { useLibraryStore } from '../../stores/libraryStore';
import { useUiStore } from '../../stores/uiStore';
import { useToastStore } from '../../stores/toastStore';
import { useArtwork } from '../../utils/useArtwork';
import { playTrack, clearQueue, addToQueue } from '../../utils/tauri';
import SongTable from './SongTable';
import './AlbumDetails.css';

export default function AlbumDetails({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const { selectedAlbum, setSelectedAlbum } = useUiStore();
  const { tracks } = useLibraryStore();

  const { artworkUrl } = useArtwork(selectedAlbum?.artwork_track_id || null);

  // Filter tracks for this album
  const albumTracks = useMemo(() => {
    if (!selectedAlbum) return [];
    
    // Sort by disc number, then track number
    return tracks
      .filter(t => t.album === selectedAlbum.name && t.album_artist === selectedAlbum.artist)
      .sort((a, b) => {
        if (a.disc_number !== b.disc_number) {
          return (a.disc_number || 1) - (b.disc_number || 1);
        }
        return (a.track_number || 0) - (b.track_number || 0);
      });
  }, [tracks, selectedAlbum]);

  if (!selectedAlbum) return null;

  const handlePlayAll = async () => {
    if (albumTracks.length === 0) return;
    
    try {
      // 1. Clear the queue
      await clearQueue();
      
      // 2. Play the first track directly (this automatically adds it to queue and starts playback)
      await playTrack(albumTracks[0].id);
      
      // 3. Add the rest of the tracks to the queue in the background
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
      // Let's show a toast so we know if it threw an error
      useToastStore.getState().addToast(`Play album failed: ${err.toString()}`, 'error');
    }
  };

  const totalDuration = useMemo(() => {
    const totalSecs = albumTracks.reduce((acc, t) => acc + t.duration_secs, 0);
    const mins = Math.floor(totalSecs / 60);
    const secs = Math.round(totalSecs % 60);
    return `${mins} min ${secs} sec`;
  }, [albumTracks]);

  return (
    <div className="album-details animate-fade-in">
      {artworkUrl && (
        <div className="album-backdrop">
          <img src={artworkUrl} alt="" className="album-backdrop-img" />
          <div className="album-backdrop-overlay"></div>
        </div>
      )}

      <div className="album-content-wrapper">
        <button className="back-btn" onClick={() => setSelectedAlbum(null)}>
          <ArrowLeft size={20} />
          <span>Back to Albums</span>
        </button>

        <div className="album-details-header">
          <div className="album-details-art-container">
            {artworkUrl ? (
              <img src={artworkUrl} alt={selectedAlbum.name} className="album-details-art" />
            ) : (
              <div className="album-details-art-placeholder">
                <Disc size={64} className="text-tertiary" />
              </div>
            )}
          </div>
          
          <div className="album-details-info">
            <span className="album-details-type">Album</span>
            <h1 className="album-details-title">{selectedAlbum.name}</h1>
            
            <div className="album-details-meta">
              <span className="album-details-artist">{selectedAlbum.artist}</span>
              {selectedAlbum.year && (
                <>
                  <span className="meta-separator">•</span>
                  <span>{selectedAlbum.year}</span>
                </>
              )}
              <span className="meta-separator">•</span>
              <span>{albumTracks.length} songs, {totalDuration}</span>
            </div>

            <div className="album-details-actions">
              <button className="btn btn-primary" onClick={handlePlayAll}>
                <Play size={20} fill="currentColor" className="play-icon-offset" />
                Play
              </button>
            </div>
          </div>
        </div>

        <div className="album-details-tracks">
          <SongTable tracks={albumTracks} hideArtwork={true} hideAlbumColumn={true} scrollRef={scrollRef} />
        </div>
      </div>
    </div>
  );
}

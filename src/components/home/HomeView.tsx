import { useMemo } from 'react';
import { useLibraryStore } from '../../stores/libraryStore';
import { useUiStore } from '../../stores/uiStore';
import { Play, Shuffle, ListMusic, Mic2, Disc, Music } from 'lucide-react';
import { playTrack, clearQueue, addToQueue } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import { useArtwork } from '../../utils/useArtwork';
import type { Track } from '../../types';
import AlbumGrid from '../library/AlbumGrid';
import './HomeView.css';

// Mini component for featured track
function FeaturedTrackItem({ track }: { track: Track }) {
  const { artworkUrl } = useArtwork(track.id);

  const handlePlay = async () => {
    await clearQueue();
    await playTrack(track.file_path);
  };

  return (
    <div className="featured-track-item" onClick={handlePlay}>
      <div className="featured-track-art">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" />
        ) : (
          <Music size={20} className="text-tertiary" />
        )}
        <div className="featured-track-play">
          <Play size={20} fill="currentColor" className="play-icon-offset" />
        </div>
      </div>
      <div className="featured-track-info">
        <div className="featured-track-title truncate" title={track.title}>{track.title}</div>
        <div className="featured-track-artist truncate" title={track.artist}>{track.artist}</div>
      </div>
      <div className="featured-track-duration">
        {formatTime(track.duration_secs)}
      </div>
    </div>
  );
}

export default function HomeView() {
  const { tracks, albums } = useLibraryStore();
  const { setActiveSection, setActiveLibraryView } = useUiStore();

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good Morning";
    if (hour < 18) return "Good Afternoon";
    return "Good Evening";
  }, []);

  // Get 6 "recently added" or random albums
  const featuredAlbums = useMemo(() => {
    if (albums.length === 0) return [];
    // For now, since we don't have play history, just take a slice
    // In a real app we might sort by a date_added field. 
    // Let's just pick the last 6 from the list to simulate "recently added".
    return [...albums].reverse().slice(0, 6);
  }, [albums]);

  // Get 5 random tracks for discover
  const featuredTracks = useMemo(() => {
    if (tracks.length === 0) return [];
    const shuffled = [...tracks].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 5);
  }, [tracks]);

  const handleShuffleAll = async () => {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => 0.5 - Math.random());
    await clearQueue();
    await playTrack(shuffled[0].file_path);
    
    // Add rest in background
    setTimeout(async () => {
      for (let i = 1; i < shuffled.length; i++) {
        try {
          await addToQueue(shuffled[i]);
        } catch (e) {
          // ignore
        }
      }
    }, 100);
  };

  return (
    <div className="home-view">
      <h1 className="home-greeting">{greeting}</h1>

      <div className="quick-actions-grid">
        <div className="quick-action-card" onClick={handleShuffleAll}>
          <div className="quick-action-icon">
            <Shuffle size={24} />
          </div>
          <div className="quick-action-details">
            <h3>Shuffle All</h3>
            <p>Play random tracks</p>
          </div>
        </div>
        
        <div className="quick-action-card" onClick={() => {
          setActiveSection('library');
          setActiveLibraryView('songs');
        }}>
          <div className="quick-action-icon">
            <ListMusic size={24} />
          </div>
          <div className="quick-action-details">
            <h3>All Songs</h3>
            <p>{tracks.length} tracks available</p>
          </div>
        </div>

        <div className="quick-action-card" onClick={() => {
          setActiveSection('library');
          setActiveLibraryView('artists');
        }}>
          <div className="quick-action-icon">
            <Mic2 size={24} />
          </div>
          <div className="quick-action-details">
            <h3>Browse Artists</h3>
            <p>Explore your favorite creators</p>
          </div>
        </div>
      </div>

      {featuredAlbums.length > 0 && (
        <div className="home-section">
          <h2 className="section-title">
            <Disc size={24} className="text-accent" />
            Recently Added Albums
          </h2>
          <div style={{ marginTop: '-1rem' }}>
            <AlbumGrid albums={featuredAlbums} horizontal={true} />
          </div>
        </div>
      )}

      {featuredTracks.length > 0 && (
        <div className="home-section">
          <h2 className="section-title">
            <Music size={24} className="text-accent" />
            Discover Tracks
          </h2>
          <div className="featured-tracks-list">
            {featuredTracks.map(track => (
              <FeaturedTrackItem key={track.id} track={track} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

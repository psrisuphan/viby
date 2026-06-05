import { useState, useMemo, useEffect, useCallback } from 'react';
import { useLibraryStore } from '../../stores/libraryStore';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';
import { Play, Shuffle, ListMusic, Mic2, Music, ChevronRight, Clock, TrendingUp, Sparkles, Disc3 } from 'lucide-react';
import { playTrack, clearQueue, addTracksToQueue, getRecentlyPlayed, getTopArtistsPlayed, getRecentlyAddedTracks } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import { useArtwork } from '../../utils/useArtwork';
import type { Track, TopArtist } from '../../types';
import AlbumGrid from '../library/AlbumGrid';
import './HomeView.css';

// ─── Sub-components ───────────────────────────────────────────────────────────

function TrackCard({ track }: { track: Track }) {
  const { artworkUrl } = useArtwork(track.id);
  const handlePlay = async () => {
    await clearQueue();
    await playTrack(track.id);
  };
  return (
    <div className="home-track-card" onClick={handlePlay}>
      <div className="home-track-card-art">
        {artworkUrl ? <img src={artworkUrl} alt="" /> : <Music size={18} className="text-tertiary" />}
        <div className="home-track-card-overlay">
          <Play size={16} fill="currentColor" />
        </div>
      </div>
      <div className="home-track-card-info">
        <div className="home-track-card-title truncate">{track.title}</div>
        <div className="home-track-card-artist truncate">{track.artist}</div>
      </div>
    </div>
  );
}

function ArtistCard({ artist }: { artist: TopArtist }) {
  const { artworkUrl } = useArtwork(artist.artwork_track_id ?? '');
  const setActiveSection = useUiStore(s => s.setActiveSection);
  const setActiveLibraryView = useUiStore(s => s.setActiveLibraryView);
  return (
    <div className="home-artist-card" onClick={() => { setActiveSection('library'); setActiveLibraryView('artists'); }}>
      <div className="home-artist-art">
        {artworkUrl ? <img src={artworkUrl} alt="" /> : <Mic2 size={24} className="text-tertiary" />}
      </div>
      <div className="home-artist-name truncate">{artist.name}</div>
      <div className="home-artist-plays">{artist.play_count.toLocaleString()} plays</div>
    </div>
  );
}


function LibraryStats({ tracks, albums, artists }: { tracks: number; albums: number; artists: number }) {
  const totalSecs = useLibraryStore(s => s.tracks.reduce((acc, t) => acc + t.duration_secs, 0));
  const formatDuration = (secs: number) => {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  return (
    <div className="home-stats-row">
      <div className="home-stat"><span className="home-stat-value">{tracks.toLocaleString()}</span><span className="home-stat-label">songs</span></div>
      <div className="home-stat-sep" />
      <div className="home-stat"><span className="home-stat-value">{albums.toLocaleString()}</span><span className="home-stat-label">albums</span></div>
      <div className="home-stat-sep" />
      <div className="home-stat"><span className="home-stat-value">{artists.toLocaleString()}</span><span className="home-stat-label">artists</span></div>
      <div className="home-stat-sep" />
      <div className="home-stat"><span className="home-stat-value">{formatDuration(totalSecs)}</span><span className="home-stat-label">of music</span></div>
    </div>
  );
}

// ─── Genre pill colours ───────────────────────────────────────────────────────

const GENRE_HUES = [160, 200, 270, 30, 320, 60, 180, 350, 100, 240];

// ─── Main component ──────────────────────────────────────────────────────────

export default function HomeView() {
  const tracks = useLibraryStore(s => s.tracks);
  const albums = useLibraryStore(s => s.albums);
  const artists = useLibraryStore(s => s.artists);
  const setActiveSection = useUiStore(s => s.setActiveSection);
  const setActiveLibraryView = useUiStore(s => s.setActiveLibraryView);
  const setSelectedAlbum = useUiStore(s => s.setSelectedAlbum);

  const currentTrackId = usePlayerStore(s => s.currentTrack?.id);

  const [recentlyPlayed, setRecentlyPlayed] = useState<Track[]>([]);
  const [topArtists, setTopArtists] = useState<TopArtist[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<Track[]>([]);

  const loadHistoryData = useCallback(async () => {
    const [rp, ta, ra] = await Promise.allSettled([
      getRecentlyPlayed(),
      getTopArtistsPlayed(),
      getRecentlyAddedTracks(),
    ]);
    if (rp.status === 'fulfilled') setRecentlyPlayed(rp.value);
    if (ta.status === 'fulfilled') setTopArtists(ta.value);
    if (ra.status === 'fulfilled') setRecentlyAdded(ra.value);
  }, []);

  const reloadPlayHistory = useCallback(async () => {
    const [rp, ta] = await Promise.allSettled([getRecentlyPlayed(), getTopArtistsPlayed()]);
    if (rp.status === 'fulfilled') setRecentlyPlayed(rp.value);
    if (ta.status === 'fulfilled') setTopArtists(ta.value);
  }, []);

  // Full load on mount
  useEffect(() => { loadHistoryData(); }, [loadHistoryData]);

  // Refresh play history whenever the current track changes
  useEffect(() => {
    if (currentTrackId) reloadPlayHistory();
  }, [currentTrackId, reloadPlayHistory]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good Morning';
    if (h < 18) return 'Good Afternoon';
    return 'Good Evening';
  }, []);

  const genres = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of tracks) {
      if (t.genre && t.genre !== 'Unknown' && !seen.has(t.genre)) {
        seen.add(t.genre);
        result.push(t.genre);
      }
    }
    return result.sort();
  }, [tracks]);

  const spotlightAlbum = useMemo(() => {
    if (albums.length === 0) return null;
    return albums[Math.floor(Math.random() * albums.length)];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums.length]);

  const discoverTracks = useMemo(() => {
    if (tracks.length === 0) return [];
    return [...tracks].sort(() => 0.5 - Math.random()).slice(0, 5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length]);

  const recentAlbums = useMemo(() => [...albums].reverse().slice(0, 8), [albums]);

  const handleShuffleAll = async () => {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => 0.5 - Math.random());
    await clearQueue();
    await playTrack(shuffled[0].id);
    if (shuffled.length > 1) {
      await addTracksToQueue(shuffled.slice(1));
    }
  };

  const handlePlaySpotlight = async () => {
    if (!spotlightAlbum) return;
    const albumTracks = tracks.filter(t => t.album === spotlightAlbum.name && t.album_artist === spotlightAlbum.artist);
    if (albumTracks.length === 0) return;
    await clearQueue();
    await playTrack(albumTracks[0].id);
    if (albumTracks.length > 1) {
      await addTracksToQueue(albumTracks.slice(1));
    }
  };

  if (tracks.length === 0) {
    return (
      <div className="home-view home-empty">
        <h1 className="home-greeting">{greeting}</h1>
        <div className="home-empty-state">
          <Music size={56} className="text-tertiary" />
          <h2>Your library is empty</h2>
          <p>Add some music folders to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="home-view">
      {/* Header */}
      <div className="home-header">
        <h1 className="home-greeting">{greeting}</h1>
        <LibraryStats tracks={tracks.length} albums={albums.length} artists={artists.length} />
      </div>

      {/* Quick Actions */}
      <div className="quick-actions-grid">
        <div className="quick-action-card" onClick={handleShuffleAll}>
          <div className="quick-action-icon"><Shuffle size={22} /></div>
          <div className="quick-action-details">
            <h3>Shuffle All</h3>
            <p>Play {tracks.length.toLocaleString()} tracks randomly</p>
          </div>
        </div>
        <div className="quick-action-card" onClick={() => { setActiveSection('library'); setActiveLibraryView('songs'); }}>
          <div className="quick-action-icon"><ListMusic size={22} /></div>
          <div className="quick-action-details">
            <h3>All Songs</h3>
            <p>Browse your full library</p>
          </div>
        </div>
        <div className="quick-action-card" onClick={() => { setActiveSection('library'); setActiveLibraryView('artists'); }}>
          <div className="quick-action-icon"><Mic2 size={22} /></div>
          <div className="quick-action-details">
            <h3>Browse Artists</h3>
            <p>{artists.length.toLocaleString()} artists in library</p>
          </div>
        </div>
      </div>

      {/* Recently Played */}
      {recentlyPlayed.length > 0 && (
        <div className="home-section">
          <div className="home-section-header">
            <h2 className="section-title"><Clock size={18} className="text-accent" />Recently Played</h2>
          </div>
          <div className="home-track-cards-row">
            {recentlyPlayed.map(track => <TrackCard key={track.id} track={track} />)}
          </div>
        </div>
      )}

      {/* Top Artists */}
      {topArtists.length > 0 && (
        <div className="home-section">
          <div className="home-section-header">
            <h2 className="section-title"><TrendingUp size={18} className="text-accent" />Top Artists</h2>
            <button className="home-see-all" onClick={() => { setActiveSection('library'); setActiveLibraryView('artists'); }}>
              See all <ChevronRight size={14} />
            </button>
          </div>
          <div className="home-artist-grid">
            {topArtists.map(a => <ArtistCard key={a.name} artist={a} />)}
          </div>
        </div>
      )}

      {/* Recently Added Tracks */}
      {recentlyAdded.length > 0 && (
        <div className="home-section">
          <div className="home-section-header">
            <h2 className="section-title"><Sparkles size={18} className="text-accent" />Recently Added</h2>
            <button className="home-see-all" onClick={() => { setActiveSection('library'); setActiveLibraryView('songs'); }}>
              See all <ChevronRight size={14} />
            </button>
          </div>
          <div className="home-track-cards-row">
            {recentlyAdded.slice(0, 12).map(track => <TrackCard key={track.id} track={track} />)}
          </div>
        </div>
      )}

      {/* Recently Added Albums */}
      {recentAlbums.length > 0 && (
        <div className="home-section">
          <div className="home-section-header">
            <h2 className="section-title"><Disc3 size={18} className="text-accent" />Recently Added Albums</h2>
            <button className="home-see-all" onClick={() => { setActiveSection('library'); setActiveLibraryView('albums'); }}>
              See all <ChevronRight size={14} />
            </button>
          </div>
          <div style={{ marginTop: '-0.5rem' }}>
            <AlbumGrid albums={recentAlbums} horizontal={true} />
          </div>
        </div>
      )}

      {/* Genre Pills */}
      {genres.length > 0 && (
        <div className="home-section">
          <h2 className="section-title"><Music size={18} className="text-accent" />Browse by Genre</h2>
          <div className="home-genre-pills">
            {genres.map((genre, i) => (
              <button
                key={genre}
                className="home-genre-pill"
                style={{ '--genre-hue': GENRE_HUES[i % GENRE_HUES.length] } as React.CSSProperties}
                onClick={() => { setActiveSection('library'); setActiveLibraryView('songs'); }}
              >
                {genre}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Album Spotlight */}
      {spotlightAlbum && (
        <SpotlightCard
          album={spotlightAlbum}
          onPlay={handlePlaySpotlight}
          onNavigate={() => { setActiveSection('library'); setSelectedAlbum(spotlightAlbum); }}
          onViewAlbums={() => { setActiveSection('library'); setActiveLibraryView('albums'); }}
        />
      )}

      {/* Discover Tracks */}
      {discoverTracks.length > 0 && (
        <div className="home-section">
          <h2 className="section-title"><Shuffle size={18} className="text-accent" />Discover Tracks</h2>
          <div className="featured-tracks-list">
            {discoverTracks.map(track => <FeaturedTrackItem key={track.id} track={track} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Spotlight ────────────────────────────────────────────────────────────────

function SpotlightCard({ album, onPlay, onNavigate, onViewAlbums }: { album: import('../../types').Album; onPlay: () => void; onNavigate: () => void; onViewAlbums: () => void }) {
  const { artworkUrl } = useArtwork(album.artwork_track_id ?? '');
  return (
    <div className="home-section">
      <h2 className="section-title"><Disc3 size={18} className="text-accent" />Album Spotlight</h2>
      <div className="spotlight-card" onClick={onNavigate}>
        <div className="spotlight-bg" style={artworkUrl ? { backgroundImage: `url(${artworkUrl})` } : undefined} />
        <div className="spotlight-art">
          {artworkUrl ? <img src={artworkUrl} alt="" /> : <Disc3 size={48} className="text-tertiary" />}
        </div>
        <div className="spotlight-info">
          <div className="spotlight-label">Album</div>
          <div className="spotlight-title">{album.name}</div>
          <div className="spotlight-artist">{album.artist}{album.year ? ` · ${album.year}` : ''}</div>
          <div className="spotlight-meta">{album.track_count} tracks</div>
          <div className="spotlight-actions">
            <button className="spotlight-play-btn" onClick={e => { e.stopPropagation(); onPlay(); }}>
              <Play size={16} fill="currentColor" /> Play Album
            </button>
            <button className="spotlight-browse-btn" onClick={e => { e.stopPropagation(); onViewAlbums(); }}>
              Browse Albums
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Featured track row item (existing style, kept) ──────────────────────────

function FeaturedTrackItem({ track }: { track: Track }) {
  const { artworkUrl } = useArtwork(track.id);
  const handlePlay = async () => { await clearQueue(); await playTrack(track.id); };
  return (
    <div className="featured-track-item" onClick={handlePlay}>
      <div className="featured-track-art">
        {artworkUrl ? <img src={artworkUrl} alt="" /> : <Music size={16} className="text-tertiary" />}
        <div className="featured-track-play"><Play size={14} fill="currentColor" className="play-icon-offset" /></div>
      </div>
      <div className="featured-track-info">
        <div className="featured-track-title truncate">{track.title}</div>
        <div className="featured-track-artist truncate">{track.artist}</div>
      </div>
      <div className="featured-track-duration">{formatTime(track.duration_secs)}</div>
    </div>
  );
}

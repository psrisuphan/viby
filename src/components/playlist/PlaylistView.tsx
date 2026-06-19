import { useState, useEffect, useMemo } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { useToastStore } from '../../stores/toastStore';
import { getPlaylistTracks, deletePlaylist, getPlaylists, addToQueue } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import type { Track } from '../../types';
import SongTable from '../library/SongTable';
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu';
import { useArtwork } from '../../utils/useArtwork';
import { Music, Clock, Hash, Trash2, MoreHorizontal, ListPlus } from 'lucide-react';
import './PlaylistView.css';

function ArtworkLayer({ trackId, isActive }: { trackId: string, isActive: boolean }) {
  const { artworkUrl } = useArtwork(trackId);
  if (!artworkUrl) return null;
  return (
    <img 
      src={artworkUrl} 
      alt="Playlist Cover" 
      className={`playlist-art-layer ${isActive ? 'active' : ''}`}
    />
  );
}

function PlaylistArtwork({ tracks }: { tracks: Track[] }) {
  // Get up to 10 unique albums to rotate through
  const sampleTracks = useMemo(() => {
    const seenAlbums = new Set<string>();
    const sampled: Track[] = [];
    for (const t of tracks) {
      const albumKey = `${t.album}-${t.album_artist}`;
      if (!seenAlbums.has(albumKey)) {
        seenAlbums.add(albumKey);
        sampled.push(t);
        if (sampled.length >= 10) break;
      }
    }
    return sampled;
  }, [tracks]);

  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (sampleTracks.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % sampleTracks.length);
    }, 8000); // 8 seconds per image
    return () => clearInterval(interval);
  }, [sampleTracks.length]);

  return (
    <div className="playlist-art-placeholder">
      {sampleTracks.length > 0 ? (
        sampleTracks.map((track, i) => (
          <ArtworkLayer 
            key={track.id} 
            trackId={track.id} 
            isActive={i === currentIndex} 
          />
        ))
      ) : (
        <Music size={64} />
      )}
    </div>
  );
}

export default function PlaylistView() {
  const activePlaylist = useUiStore((s) => s.activePlaylist);
  const setActiveSection = useUiStore((s) => s.setActiveSection);
  const setActivePlaylist = useUiStore((s) => s.setActivePlaylist);
  const setPlaylists = useLibraryStore((s) => s.setPlaylists);
  const addToast = useToastStore((s) => s.addToast);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;
    
    if (activePlaylist) {
      setIsLoading(true);
      getPlaylistTracks(activePlaylist.id)
        .then(fetchedTracks => {
          if (isMounted) {
            setTracks(fetchedTracks);
            setIsLoading(false);
          }
        })
        .catch(err => {
          console.error("Failed to fetch playlist tracks:", err);
          if (isMounted) {
            setIsLoading(false);
          }
        });
    }

    return () => {
      isMounted = false;
    };
  }, [activePlaylist]);

  const handleDeletePlaylist = async () => {
    if (!activePlaylist) return;

    try {
      await deletePlaylist(activePlaylist.id);
      const updatedPlaylists = await getPlaylists();
      setPlaylists(updatedPlaylists);
      addToast(`Deleted playlist "${activePlaylist.name}"`, 'success');
      
      // Navigate away
      setActivePlaylist(null);
      setActiveSection('home');
      setIsDeleteModalOpen(false);
    } catch (err) {
      console.error("Failed to delete playlist:", err);
      addToast("Failed to delete playlist", 'error');
    }
  };

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleAddToQueue = async () => {
    if (tracks.length === 0) return;
    
    let addedCount = 0;
    for (const track of tracks) {
      try {
        await addToQueue(track);
        addedCount++;
      } catch (err) {
        console.error("Failed to add track to queue", err);
      }
    }
    
    if (addedCount > 0) {
      addToast(`Added ${addedCount} tracks to queue`, 'success');
    }
    setMenuPos(null);
  };

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Add to Queue',
      icon: <ListPlus size={14} />,
      onClick: handleAddToQueue
    },
    {
      label: 'Delete Playlist',
      icon: <Trash2 size={14} />,
      isDanger: true,
      onClick: () => {
        setIsDeleteModalOpen(true);
        setMenuPos(null);
      }
    }
  ];

  if (!activePlaylist) {
    return (
      <div className="empty-state">
        <Music size={48} opacity={0.2} style={{ margin: '0 auto var(--space-md)' }} />
        <h3>No Playlist Selected</h3>
        <p>Select a playlist from the sidebar.</p>
      </div>
    );
  }

  const totalDurationSecs = tracks.reduce((acc, t) => acc + t.duration_secs, 0);

  return (
    <div className="playlist-view">
      <div className="playlist-header">
        <PlaylistArtwork tracks={tracks} />
        
        <div className="playlist-info">
          <div className="playlist-type">Playlist</div>
          <div className="playlist-title-row">
            <h1 className="playlist-name">{activePlaylist.name}</h1>
            <button 
              className="icon-btn" 
              title="Playlist Options"
              onClick={handleMenuClick}
            >
              <MoreHorizontal size={24} />
            </button>
          </div>
          <div className="playlist-meta">
            <span className="meta-item">
              <Hash size={14} />
              {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
            </span>
            <span className="meta-item">
              <Clock size={14} />
              {formatTime(totalDurationSecs)}
            </span>
          </div>
        </div>
      </div>

      <div className="playlist-tracks">
        {isLoading ? (
          <div className="empty-state">
            <div className="spinner animate-spin"></div>
            <p>Loading tracks...</p>
          </div>
        ) : tracks.length > 0 ? (
          <SongTable tracks={tracks} />
        ) : (
          <div className="empty-state">
            <Music size={48} opacity={0.2} style={{ margin: '0 auto var(--space-md)' }} />
            <h3>This playlist is empty</h3>
            <p>Right-click any song in your library to add it here.</p>
          </div>
        )}
      </div>

      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={() => setMenuPos(null)}
        />
      )}

      {isDeleteModalOpen && (
        <div className="modal-overlay" onClick={() => setIsDeleteModalOpen(false)}>
          <div className="modal-content glass-panel-heavy" style={{ width: '400px', maxWidth: '90vw', padding: 'var(--space-xl)', borderRadius: 'var(--radius-lg)' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, color: 'var(--text-primary)' }}>Delete Playlist?</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-xl)' }}>
              Are you sure you want to delete <strong>"{activePlaylist.name}"</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-md)' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setIsDeleteModalOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-danger" onClick={handleDeletePlaylist}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

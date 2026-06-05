import { Home, Music, Disc, Mic2, ListMusic, Settings, FolderPlus } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { scanLibrary, addLibraryFolder, createPlaylist, getPlaylists } from '../../utils/tauri';
import { useLibraryStore } from '../../stores/libraryStore';
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import './Sidebar.css';

export default function Sidebar() {
  const { activeSection, setActiveSection, activeLibraryView, setActiveLibraryView, activePlaylist, setActivePlaylist } = useUiStore();
  const { isScanning, playlists, setPlaylists } = useLibraryStore();
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');

  const handleAddFolder = async () => {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: 'Select Music Folder',
      });

      if (selectedPath && typeof selectedPath === 'string') {
        await addLibraryFolder(selectedPath);
        await scanLibrary();
      }
    } catch (error) {
      console.error("Failed to add library folder:", error);
    }
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;
    
    try {
      await createPlaylist(newPlaylistName.trim());
      const updatedPlaylists = await getPlaylists();
      setPlaylists(updatedPlaylists);
      setCreateModalOpen(false);
      setNewPlaylistName('');
    } catch (error) {
      console.error("Failed to create playlist:", error);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <nav className="sidebar-nav">
          <div className="nav-section">
            <button 
              className={`nav-item ${activeSection === 'home' ? 'active' : ''}`}
              onClick={() => setActiveSection('home')}
            >
              <Home size={20} />
              <span>Home</span>
            </button>
          </div>

          <div className="nav-section">
            <div className="section-header">
              <h3 className="section-title">Library</h3>
            </div>
            <button 
              className={`nav-item ${activeSection === 'library' && activeLibraryView === 'songs' ? 'active' : ''}`}
              onClick={() => {
                setActiveSection('library');
                setActiveLibraryView('songs');
              }}
            >
              <Music size={20} />
              <span>Songs</span>
            </button>
            <button 
              className={`nav-item ${activeSection === 'library' && activeLibraryView === 'albums' ? 'active' : ''}`}
              onClick={() => {
                setActiveSection('library');
                setActiveLibraryView('albums');
              }}
            >
              <Disc size={20} />
              <span>Albums</span>
            </button>
            <button 
              className={`nav-item ${activeSection === 'library' && activeLibraryView === 'artists' ? 'active' : ''}`}
              onClick={() => {
                setActiveSection('library');
                setActiveLibraryView('artists');
              }}
            >
              <Mic2 size={20} />
              <span>Artists</span>
            </button>
          </div>

          <div className="nav-section">
            <div className="section-header">
              <h3 className="section-title">Playlists</h3>
              <button 
                className="icon-btn section-action" 
                onClick={() => setCreateModalOpen(true)}
                title="New Playlist"
              >
                <FolderPlus size={16} />
              </button>
            </div>
            
            {playlists.map(playlist => (
              <button 
                key={playlist.id}
                className={`nav-item ${activeSection === 'playlist' && activePlaylist?.id === playlist.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveSection('playlist');
                  setActivePlaylist(playlist);
                }}
              >
                <ListMusic size={20} />
                <span className="truncate">{playlist.name}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>

      <div className="sidebar-footer">
        <button 
          className="sidebar-action-btn"
          onClick={handleAddFolder}
          disabled={isScanning}
        >
          <FolderPlus size={18} />
          <span>{isScanning ? 'Scanning...' : 'Add Music'}</span>
        </button>
        <button className="icon-btn" title="Settings">
          <Settings size={20} />
        </button>
      </div>

      {/* Simple Create Playlist Modal */}
      {isCreateModalOpen && (
        <div className="modal-overlay" onClick={() => setCreateModalOpen(false)}>
          <div className="modal-content glass-panel-heavy create-playlist-modal" onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 'var(--space-lg)' }}>New Playlist</h2>
            <form onSubmit={handleCreatePlaylist}>
              <input
                type="text"
                value={newPlaylistName}
                onChange={e => setNewPlaylistName(e.target.value)}
                placeholder="Playlist name"
                autoFocus
                className="search-input"
                style={{ width: '100%', marginBottom: 'var(--space-lg)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-md)' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setCreateModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!newPlaylistName.trim()}>
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </aside>
  );
}

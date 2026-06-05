import { Home, Music, Disc, Mic2, ListMusic, Settings, FolderPlus } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { scanLibrary, addLibraryFolder } from '../../utils/tauri';
import { useLibraryStore } from '../../stores/libraryStore';
import { open } from '@tauri-apps/plugin-dialog';
import './Sidebar.css';

export default function Sidebar() {
  const { activeSection, setActiveSection, activeLibraryView, setActiveLibraryView } = useUiStore();
  const { isScanning } = useLibraryStore();

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
            <h3 className="section-title">Library</h3>
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
            <h3 className="section-title">Playlists</h3>
            {/* Playlists would map here */}
            <button className="nav-item">
              <ListMusic size={20} />
              <span>Favorites</span>
            </button>
            <button className="nav-item">
              <ListMusic size={20} />
              <span>Chill Vibes</span>
            </button>
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
    </aside>
  );
}

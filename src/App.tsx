import { useEffect } from 'react';
import { useUiStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import { useLibraryStore } from './stores/libraryStore';
import { 
  onPlaybackStateChange, 
  onScanProgress, 
  getAllTracks, 
  getAlbums, 
  getArtists 
} from './utils/tauri';

// Global Styles
import './styles/design-tokens.css';
import './styles/reset.css';
import './styles/globals.css';
import './styles/animations.css';

// Components
import Titlebar from './components/layout/Titlebar';
import Sidebar from './components/layout/Sidebar';
import PlayerBar from './components/layout/PlayerBar';
import LibraryView from './components/library/LibraryView';
import SearchModal from './components/search/SearchModal';
import QueuePanel from './components/player/QueuePanel';

function App() {
  const { isTheaterMode, isQueueOpen, isSearchOpen } = useUiStore();
  const { setIsPlaying, setCurrentTrack, setPosition, setDuration } = usePlayerStore();
  const { setTracks, setAlbums, setArtists, setScanState } = useLibraryStore();

  const loadLibraryData = async () => {
    try {
      const [tracks, albums, artists] = await Promise.all([
        getAllTracks(),
        getAlbums(),
        getArtists()
      ]);
      setTracks(tracks);
      setAlbums(albums);
      setArtists(artists);
    } catch (e) {
      console.error("Failed to load library data:", e);
    }
  };

  useEffect(() => {
    // Initial library load
    loadLibraryData();

    // Listen to Rust audio state changes
    const unlistenAudio = onPlaybackStateChange((state) => {
      setIsPlaying(state.is_playing);
      setCurrentTrack(state.current_track);
      setPosition(state.position_secs);
      setDuration(state.duration_secs);
    });

    // Listen for library scan progress
    const unlistenScan = onScanProgress((progress) => {
      const percent = progress.total_files > 0 
        ? (progress.processed_files / progress.total_files) * 100 
        : 0;
      
      setScanState(
        progress.status !== 'complete' && progress.status !== 'error',
        percent,
        progress.status === 'scanning' 
          ? `Scanning: ${progress.current_file}` 
          : progress.status
      );

      // If scan completed, reload the library data
      if (progress.status === 'complete') {
        loadLibraryData();
      }
    });

    return () => {
      unlistenAudio.then(fn => fn());
      unlistenScan.then(fn => fn());
    };
  }, []);

  return (
    <div className={`app-container ${isTheaterMode ? 'theater-mode' : ''}`}>
      <Titlebar />
      
      <div className="main-content">
        <Sidebar />
        
        <main className="content-area">
          <LibraryView />
        </main>

        {isQueueOpen && <QueuePanel />}
      </div>
      
      <PlayerBar />
      
      {isSearchOpen && <SearchModal />}
    </div>
  );
}

export default App;

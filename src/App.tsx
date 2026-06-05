import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUiStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import { useLibraryStore } from './stores/libraryStore';
import { useQueueStore } from './stores/queueStore';
import { 
  onPlaybackStateChange, 
  onScanProgress, 
  getAllTracks, 
  getAlbums, 
  getArtists,
  getPlaylists,
  setVolume as setRustVolume,
  setShuffle as setRustShuffle,
  setRepeat as setRustRepeat,
  getQueue,
  onQueueChanged,
  onTrackEnded,
  nextTrack
} from './utils/tauri';

// Global Styles
import './styles/design-tokens.css';
import './styles/reset.css';
import './styles/globals.css';
import './styles/animations.css';
import './App.css';

// Components
import Titlebar from './components/layout/Titlebar';
import Sidebar from './components/layout/Sidebar';
import PlayerBar from './components/layout/PlayerBar';
import LibraryView from './components/library/LibraryView';
import SearchModal from './components/search/SearchModal';
import QueuePanel from './components/player/QueuePanel';
import ToastContainer from './components/ui/ToastContainer';
import PlaylistView from './components/playlist/PlaylistView';

function App() {
  const { isTheaterMode, isQueueOpen, isSearchOpen, activeSection } = useUiStore();
  const { 
    currentTrack,
    setVolume,
    setIsPlaying,
    setCurrentTrack,
    setPosition,
    setDuration,
  } = usePlayerStore();
  const { setTracks, setAlbums, setArtists, setScanState, setPlaylists } = useLibraryStore();
  const { setQueueState } = useQueueStore();

  const loadLibraryData = async () => {
    try {
      const [tracks, albums, artists, playlists] = await Promise.all([
        getAllTracks(),
        getAlbums(),
        getArtists(),
        getPlaylists()
      ]);
      setTracks(tracks);
      setAlbums(albums);
      setArtists(artists);
      setPlaylists(playlists);
    } catch (e) {
      console.error("Failed to load library data:", e);
    }
  };

  useEffect(() => {
    // Initial library load
    loadLibraryData();

    // Sync persisted player state to the Rust backend
    const syncInitialState = async () => {
      const state = usePlayerStore.getState();
      await setRustVolume(state.volume);
      await setRustShuffle(state.shuffle);
      await setRustRepeat(state.repeatMode);
      
      // Also fetch initial queue
      try {
        const q = await getQueue();
        setQueueState(q);
      } catch (e) {
        console.error("Failed to fetch initial queue", e);
      }
    };
    syncInitialState();

    // Auto-scan library on app launch to catch new music
    const autoScan = async () => {
      try {
        await invoke('scan_library');
      } catch (err) {
        console.error("Auto-scan failed:", err);
      }
    };
    autoScan();

    // Listen to Rust audio state changes
    const unlistenAudio = onPlaybackStateChange((state) => {
      setIsPlaying(state.is_playing);
      setCurrentTrack(state.current_track);
      
      setPosition(state.position_secs);
      setDuration(state.duration_secs);
      setVolume(state.volume);
      // We do NOT sync shuffle and repeat from periodic playback state because
      // the audio player thread doesn't have access to the queue state and hardcodes them to false/off.
      // The initial sync and user actions handle this instead.
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

    // Listen for queue changes
    const unlistenQueue = onQueueChanged((payload) => {
      setQueueState(payload);
    });

    // Automatically advance to the next track when the current one finishes
    const unlistenTrackEnded = onTrackEnded(() => {
      nextTrack(false).catch(e => console.error("Auto advance failed:", e));
    });

    return () => {
      unlistenAudio.then(fn => fn());
      unlistenScan.then(fn => fn());
      unlistenQueue.then(fn => fn());
      unlistenTrackEnded.then(fn => fn());
    };
  }, []);

  return (
    <div className={`app-container ${isTheaterMode ? 'theater-mode' : ''}`}>
      <Titlebar />
      
      <div className="main-content">
        <Sidebar />
        
        <div className="content-wrapper">
          <div className="content-row">
            <main className="content-area">
              {activeSection === 'playlist' ? <PlaylistView /> : <LibraryView />}
            </main>
            {isQueueOpen && <QueuePanel />}
          </div>
          
          {currentTrack && <PlayerBar />}
        </div>
      </div>
      
      {isSearchOpen && <SearchModal />}
      <ToastContainer />
    </div>
  );
}

export default App;

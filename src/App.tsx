import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition } from '@tauri-apps/api/window';

const isLinux = navigator.userAgent.toLowerCase().includes('linux');
import { listen } from '@tauri-apps/api/event';
import { useUiStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import { useSettingsStore } from './stores/settingsStore';
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
  setEq,
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
import FullscreenPlayer from './components/player/FullscreenPlayer';
import MiniPlayer from './components/player/MiniPlayer';
import ToastContainer from './components/ui/ToastContainer';
import PlaylistView from './components/playlist/PlaylistView';

function App() {
  const { isTheaterMode, isMiniPlayerOpen, setMiniPlayerOpen, isQueueOpen, isSearchOpen, activeSection } = useUiStore();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const setPlaybackSnapshot = usePlayerStore(s => s.setPlaybackSnapshot);
  const { setTracks, setAlbums, setArtists, setScanState, setPlaylists } = useLibraryStore();
  const { setQueueState } = useQueueStore();
  const unlistenFnsRef = useRef<Array<() => void>>([]);

  const savedWindowState = useRef<{ size: PhysicalSize; position: PhysicalPosition | null } | null>(null);

  const enterMiniPlayer = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      const size = await win.innerSize();
      const position = !isLinux ? await win.outerPosition() : null;
      savedWindowState.current = { size, position };
      await win.setResizable(false);
      await win.setSize(new LogicalSize(420, 165));
      await win.setAlwaysOnTop(useSettingsStore.getState().miniPlayerAlwaysOnTop);
      if (!isLinux) await win.center();
    } catch (e) {
      console.error('Mini player window resize failed:', e);
    }
    setMiniPlayerOpen(true);
  }, [setMiniPlayerOpen]);

  const exitMiniPlayer = useCallback(async () => {
    const win = getCurrentWindow();
    setMiniPlayerOpen(false);
    try {
      await win.setAlwaysOnTop(false);
      await win.setResizable(true);
      if (savedWindowState.current) {
        await win.setSize(savedWindowState.current.size);
        if (!isLinux && savedWindowState.current.position) {
          await win.setPosition(savedWindowState.current.position);
        }
      }
    } catch (e) {
      console.error('Mini player expand failed:', e);
    }
  }, [setMiniPlayerOpen]);

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
    let cancelled = false;

    const setup = async () => {
      loadLibraryData();

      // Sync persisted player state to the Rust backend
      const state = usePlayerStore.getState();
      await setRustVolume(state.volume);
      await setRustShuffle(state.shuffle);
      await setRustRepeat(state.repeatMode);

      // Sync persisted equalizer settings so the backend matches saved state
      // even before the user opens the EQ tab.
      const eq = useSettingsStore.getState();
      const qs = eq.eqCustomQ ? eq.eqQs : eq.eqGains.map(() => 1.41);
      await setEq(eq.eqEnabled, eq.eqPreamp, qs, eq.eqGains);

      try {
        const q = await getQueue();
        if (!cancelled) setQueueState(q);
      } catch (e) {
        console.error("Failed to fetch initial queue", e);
      }

      // Auto-scan library on app launch to catch new music
      invoke('scan_library').catch(err => console.error("Auto-scan failed:", err));

      // Register all event listeners and store the resolved unlisten functions
      // so cleanup is always synchronous (no promise race on unmount).
      const fns = await Promise.all([
        listen('tray-open', () => { if (!cancelled) enterMiniPlayer(); }),
        onPlaybackStateChange((s) => {
          if (cancelled) return;
          setPlaybackSnapshot(s);
          // Shuffle and repeat are NOT synced from playback-state events —
          // the audio thread hardcodes them to false/off. Initial sync and
          // user actions keep those fields correct instead.
        }),
        onScanProgress((progress) => {
          if (cancelled) return;
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
          // Only reload library data if the scan actually changed something
          if (progress.status === 'complete') {
            const changed = (progress.new_tracks ?? 0) > 0 || (progress.removed_tracks ?? 0) > 0;
            if (changed) loadLibraryData();
          }
        }),
        onQueueChanged((payload) => {
          if (!cancelled) setQueueState(payload);
        }),
        onTrackEnded(() => {
          if (!cancelled) nextTrack(false).catch(e => console.error("Auto advance failed:", e));
        }),
      ]);

      if (!cancelled) {
        unlistenFnsRef.current = fns;
      } else {
        fns.forEach(fn => fn());
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlistenFnsRef.current.forEach(fn => fn());
      unlistenFnsRef.current = [];
    };
  }, []);

  return (
    <div className={`app-container ${isTheaterMode ? 'theater-mode' : ''} ${isMiniPlayerOpen ? 'mini-player-mode' : ''}`}>
      {isMiniPlayerOpen && <MiniPlayer onExpand={exitMiniPlayer} />}

      {!isMiniPlayerOpen && !isTheaterMode && (
        <>
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
              {currentTrack && <PlayerBar onMiniPlayer={enterMiniPlayer} />}
            </div>
          </div>
        </>
      )}

      {!isMiniPlayerOpen && isTheaterMode && <FullscreenPlayer />}
      {isSearchOpen && <SearchModal />}
      <ToastContainer />
    </div>
  );
}

export default App;

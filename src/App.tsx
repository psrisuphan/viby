import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition } from '@tauri-apps/api/window';

const isLinux = navigator.userAgent.toLowerCase().includes('linux');
import { listen } from '@tauri-apps/api/event';
import { useUiStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import { useSettingsStore } from './stores/settingsStore';
import { useThemeStore, applyTheme } from './stores/themeStore';
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
  nextTrack,
  previousTrack,
  pausePlayback,
  resumePlayback,
  seekTo
} from './utils/tauri';

// Global Styles
import './styles/design-tokens.css';
import './styles/themes.css';
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
  const theme = useThemeStore(s => s.theme);

  // Apply saved theme on mount and whenever it changes
  useEffect(() => { applyTheme(theme); }, [theme]);
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
      await win.setSize(new LogicalSize(420, isLinux ? 165 : 200));
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

      const eq = useSettingsStore.getState();
      await invoke('set_close_to_tray', { enabled: eq.closeToTray }).catch((err) =>
        console.error('Failed to sync closeToTray on startup:', err)
      );

      // Sync persisted equalizer settings so the backend matches saved state
      // even before the user opens the EQ tab.
      await setEq(eq.eqEnabled, eq.eqPreamp, eq.eqGains);

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

  useEffect(() => {
    const handleGlobalKeys = async (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput = activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName);

      const isMac = navigator.userAgent.toLowerCase().includes('mac');
      const isModKey = isMac ? e.metaKey : e.ctrlKey;

      // Toggle search modal on Ctrl+K / Cmd+K
      if (isModKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const { isSearchOpen, setSearchOpen } = useUiStore.getState();
        setSearchOpen(!isSearchOpen);
        return;
      }

      // Exit App on Ctrl+Q / Cmd+Q (fallback if OS window manager doesn't capture it)
      if (isModKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        await invoke('exit_app').catch((err) =>
          console.error('Failed to exit app:', err)
        );
        return;
      }

      // If typing in an input, don't trigger playback controls
      if (isInput) return;

      // Play/Pause on Space
      if (e.key === ' ') {
        e.preventDefault();
        const { isPlaying, currentTrack } = usePlayerStore.getState();
        if (currentTrack) {
          if (isPlaying) {
            await pausePlayback().catch((err) => console.error('Failed to pause:', err));
          } else {
            await resumePlayback().catch((err) => console.error('Failed to resume:', err));
          }
        }
      }

      // Playback arrow navigation
      if (isModKey) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          await nextTrack(true).catch((err) => console.error('Failed to skip next:', err));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const { positionSecs } = usePlayerStore.getState();
          if (positionSecs > 3) {
            await seekTo(0).catch((err) => console.error('Failed to seek:', err));
          } else {
            await previousTrack(true).catch((err) => console.error('Failed to skip previous:', err));
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const currentVol = usePlayerStore.getState().volume;
          const newVol = Math.min(1, currentVol + 0.05);
          usePlayerStore.getState().setVolume(newVol);
          await setRustVolume(newVol).catch((err) => console.error('Failed to change volume:', err));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const currentVol = usePlayerStore.getState().volume;
          const newVol = Math.max(0, currentVol - 0.05);
          usePlayerStore.getState().setVolume(newVol);
          await setRustVolume(newVol).catch((err) => console.error('Failed to change volume:', err));
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeys);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeys);
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

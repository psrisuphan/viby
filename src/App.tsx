import { useEffect } from 'react';
import { useUiStore } from './stores/uiStore';
import { usePlayerStore } from './stores/playerStore';
import { onPlaybackStateChange } from './utils/tauri';

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

  // Listen to Rust audio state changes
  useEffect(() => {
    const unlisten = onPlaybackStateChange((state) => {
      setIsPlaying(state.is_playing);
      setCurrentTrack(state.current_track);
      setPosition(state.position_secs);
      setDuration(state.duration_secs);
    });

    return () => {
      unlisten.then(fn => fn());
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

import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import SongTable from './SongTable';
import AlbumGrid from './AlbumGrid';
import AlbumDetails from './AlbumDetails';
import ArtistList from './ArtistList';
import ArtistDetails from './ArtistDetails';
import HomeView from '../home/HomeView';
import './LibraryView.css';

export default function LibraryView() {
  const { activeSection, activeLibraryView, selectedAlbum, selectedArtist } = useUiStore();
  const { isScanning, scanProgress, scanStatusText, tracks, albums, artists } = useLibraryStore();

  if (activeSection === 'home') {
    return <HomeView />;
  }

  return (
    <div className="library-view">
      <div className="view-header">
        <h1>
          {activeSection === 'library' ? (activeLibraryView.charAt(0).toUpperCase() + activeLibraryView.slice(1)) : 
           'Playlist'}
        </h1>
      </div>

      <div className="view-content">
        {isScanning ? (
          <div className="empty-state">
            <div className="scanning-indicator">
              <div className="spinner animate-spin"></div>
              <h3>Scanning Library...</h3>
            </div>
            <p>{scanStatusText}</p>
            <div className="progress-bar-container">
              <div 
                className="progress-bar-fill"
                style={{ width: `${scanProgress}%` }}
              ></div>
            </div>
          </div>
        ) : activeLibraryView === 'songs' ? (
          <SongTable tracks={tracks} />
        ) : activeLibraryView === 'albums' ? (
          selectedAlbum ? <AlbumDetails /> : <AlbumGrid albums={albums} />
        ) : activeLibraryView === 'artists' ? (
          selectedArtist ? <ArtistDetails /> : <ArtistList artists={artists} />
        ) : (
          <div className="empty-state">
            <h3>Coming Soon</h3>
            <p>The {activeLibraryView} view is under construction.</p>
          </div>
        )}
      </div>
    </div>
  );
}

import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import './LibraryView.css';

export default function LibraryView() {
  const { activeSection, activeLibraryView } = useUiStore();
  const { isScanning, scanProgress, scanStatusText } = useLibraryStore();

  return (
    <div className="library-view">
      {/* Search and context header could go here */}
      <div className="view-header">
        <h1>
          {activeSection === 'home' ? 'Home' : 
           activeSection === 'library' ? (activeLibraryView.charAt(0).toUpperCase() + activeLibraryView.slice(1)) : 
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
        ) : (
          <div className="empty-state">
            <h3>Nothing here yet</h3>
            <p>Click "Add Music" in the sidebar to start building your library.</p>
          </div>
        )}
      </div>
    </div>
  );
}

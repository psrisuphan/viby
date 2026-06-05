import { X } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useQueueStore } from '../../stores/queueStore';
import './QueuePanel.css';

export default function QueuePanel() {
  const { setQueueOpen } = useUiStore();
  const { tracks, currentIndex, clearQueue } = useQueueStore();

  return (
    <aside className="queue-panel animate-slide-right">
      <div className="queue-header">
        <h2>Play Queue</h2>
        <div className="queue-actions">
          <button className="icon-btn--sm" onClick={clearQueue} title="Clear queue">
            <span className="text-xs">Clear</span>
          </button>
          <button className="icon-btn" onClick={() => setQueueOpen(false)}>
            <X size={20} />
          </button>
        </div>
      </div>
      
      <div className="queue-content">
        {tracks.length === 0 ? (
          <div className="empty-state">
            <p>Queue is empty</p>
          </div>
        ) : (
          <div className="queue-list">
            {tracks.map((track, idx) => (
              <div 
                key={`${track.id}-${idx}`} 
                className={`queue-item ${idx === currentIndex ? 'active' : ''}`}
              >
                <div className="queue-item-info">
                  <div className="queue-item-title truncate">{track.title}</div>
                  <div className="queue-item-artist truncate">{track.artist}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

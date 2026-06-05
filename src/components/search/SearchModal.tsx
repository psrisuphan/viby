import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import './SearchModal.css';

export default function SearchModal() {
  const { setSearchOpen } = useUiStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus input on mount
    inputRef.current?.focus();

    // Close on Escape
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setSearchOpen]);

  return (
    <div className="modal-overlay animate-fade-in" onClick={() => setSearchOpen(false)}>
      <div 
        className="search-modal animate-scale-in glass-panel-heavy" 
        onClick={e => e.stopPropagation()}
      >
        <div className="search-header">
          <Search size={20} className="search-icon" />
          <input 
            ref={inputRef}
            type="text" 
            placeholder="Search songs, albums, artists..." 
            className="search-input"
          />
          <button className="icon-btn" onClick={() => setSearchOpen(false)}>
            <X size={20} />
          </button>
        </div>
        
        <div className="search-results empty-state">
          <p>Type to start searching your library</p>
        </div>
      </div>
    </div>
  );
}

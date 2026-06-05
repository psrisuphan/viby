import { useState, useEffect, useCallback } from 'react';
import { X, Trash2, Database, Image, CheckCircle2, Info } from 'lucide-react';
import { clearPlayHistory } from '../../utils/tauri';
import { clearArtworkCache, getArtworkCacheSize } from '../../utils/useArtwork';
import { useToastStore } from '../../stores/toastStore';
import './SettingsModal.css';

type Tab = 'general' | 'cache';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('cache');
  const [artworkCacheSize, setArtworkCacheSize] = useState(0);
  const [clearedHistory, setClearedHistory] = useState(false);
  const [clearedArtwork, setClearedArtwork] = useState(false);
  const { addToast } = useToastStore();

  const refreshStats = useCallback(() => {
    setArtworkCacheSize(getArtworkCacheSize());
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshStats();
      setClearedHistory(false);
      setClearedArtwork(false);
      setActiveTab('cache');
    }
  }, [isOpen, refreshStats]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleClearHistory = async () => {
    try {
      await clearPlayHistory();
      setClearedHistory(true);
      addToast('Play history cleared', 'success');
    } catch {
      addToast('Failed to clear play history', 'error');
    }
  };

  const handleClearArtwork = () => {
    clearArtworkCache();
    setArtworkCacheSize(0);
    setClearedArtwork(true);
    addToast('Artwork cache cleared', 'success');
  };

  const handleClearAll = async () => {
    try {
      await clearPlayHistory();
      clearArtworkCache();
      setArtworkCacheSize(0);
      setClearedHistory(true);
      setClearedArtwork(true);
      addToast('All caches cleared', 'success');
    } catch {
      addToast('Failed to clear all caches', 'error');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal glass-panel-heavy" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="icon-btn settings-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="settings-tabs">
          <button
            className={`settings-tab${activeTab === 'general' ? ' active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`settings-tab${activeTab === 'cache' ? ' active' : ''}`}
            onClick={() => setActiveTab('cache')}
          >
            Cache
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'cache' && (
            <CacheTab
              artworkCacheSize={artworkCacheSize}
              clearedHistory={clearedHistory}
              clearedArtwork={clearedArtwork}
              onClearHistory={handleClearHistory}
              onClearArtwork={handleClearArtwork}
              onClearAll={handleClearAll}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── General tab ───────────────────────────────────────────────────────────────

function GeneralTab() {
  return (
    <div className="settings-section-list">
      <div className="settings-about">
        <div className="settings-about-name">Viby</div>
        <div className="settings-about-desc">A modern, minimal local music player</div>
        <div className="settings-about-stack">
          Built with Tauri 2 · React · Rust
        </div>
      </div>

      <div className="settings-info-row">
        <Info size={14} className="text-tertiary" />
        <span>All data is stored locally on your device. Viby has no cloud sync and makes no network requests except to load fonts.</span>
      </div>
    </div>
  );
}

// ── Cache tab ─────────────────────────────────────────────────────────────────

interface CacheTabProps {
  artworkCacheSize: number;
  clearedHistory: boolean;
  clearedArtwork: boolean;
  onClearHistory: () => void;
  onClearArtwork: () => void;
  onClearAll: () => void;
}

function CacheTab({ artworkCacheSize, clearedHistory, clearedArtwork, onClearHistory, onClearArtwork, onClearAll }: CacheTabProps) {
  return (
    <div className="settings-section-list">
      <p className="settings-section-desc">
        Clearing a cache removes stored data but does not affect your library or playlists.
      </p>

      {/* Play History */}
      <div className="cache-item">
        <div className="cache-item-icon">
          <Database size={18} />
        </div>
        <div className="cache-item-info">
          <div className="cache-item-name">Play History</div>
          <div className="cache-item-desc">
            Records every track you play to power "Recently Played" and "Top Artists" on the home page.
            Stored in your local database — persists between sessions. Capped at 5,000 entries.
          </div>
          <div className="cache-item-badge">Persists between sessions</div>
        </div>
        <div className="cache-item-action">
          {clearedHistory ? (
            <div className="cache-cleared-indicator">
              <CheckCircle2 size={16} /> Cleared
            </div>
          ) : (
            <button className="btn-cache-clear" onClick={onClearHistory}>
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Artwork Cache */}
      <div className="cache-item">
        <div className="cache-item-icon">
          <Image size={18} />
        </div>
        <div className="cache-item-info">
          <div className="cache-item-name">Artwork Cache</div>
          <div className="cache-item-desc">
            Album artwork decoded from audio files and held in memory for fast display.
            Automatically cleared when the app closes. Max 200 images at once.
          </div>
          <div className="cache-item-badge cache-item-badge--session">Session only · {artworkCacheSize} / 200 loaded</div>
        </div>
        <div className="cache-item-action">
          {clearedArtwork ? (
            <div className="cache-cleared-indicator">
              <CheckCircle2 size={16} /> Cleared
            </div>
          ) : (
            <button className="btn-cache-clear" onClick={onClearArtwork} disabled={artworkCacheSize === 0}>
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Clear All */}
      <div className="cache-clear-all-row">
        <button
          className="btn-cache-clear-all"
          onClick={onClearAll}
          disabled={clearedHistory && clearedArtwork}
        >
          <Trash2 size={15} />
          Clear All Caches
        </button>
      </div>
    </div>
  );
}

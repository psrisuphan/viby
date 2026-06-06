import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Database, Image, CheckCircle2, Info, Settings, HardDrive, ChevronDown, Check, Sliders, FlaskConical, ChevronLeft } from 'lucide-react';
import { clearPlayHistory } from '../../utils/tauri';
import { clearArtworkCache, getArtworkCacheSize } from '../../utils/useArtwork';
import { useToastStore } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';
import EqualizerTab from './EqualizerTab';
import './SettingsModal.css';

type Tab = 'general' | 'equalizer' | 'cache';

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general',   label: 'General',   icon: <Settings size={16} /> },
  { id: 'equalizer', label: 'Equalizer', icon: <Sliders size={16} /> },
  { id: 'cache',     label: 'Cache',     icon: <HardDrive size={16} /> },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [artworkCacheSize, setArtworkCacheSize] = useState(0);
  const [clearedHistory, setClearedHistory] = useState(false);
  const [clearedArtwork, setClearedArtwork] = useState(false);
  const [isPeqExpanded, setIsPeqExpanded] = useState(false);
  const { addToast } = useToastStore();
  const { eqMode } = useSettingsStore();
  const isPeq = eqMode === 'parametric';

  const refreshStats = useCallback(() => {
    setArtworkCacheSize(getArtworkCacheSize());
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshStats();
      setClearedHistory(false);
      setClearedArtwork(false);
      setActiveTab('general');
      setIsPeqExpanded(false);
    }
  }, [isOpen, refreshStats]);

  useEffect(() => {
    setIsPeqExpanded(false);
  }, [activeTab]);

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

  const isPeqPage = activeTab === 'equalizer' && isPeq && isPeqExpanded;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`settings-modal glass-panel-heavy${isPeqPage ? ' settings-modal--peq-page' : ''}`}
        onClick={e => e.stopPropagation()}
      >

        {/* Sidebar — hidden when PEQ full-page */}
        {!isPeqPage && (
          <aside className="settings-sidebar">
            <div className="settings-sidebar-title">Settings</div>
            <nav className="settings-nav">
              {NAV_ITEMS.map(item => (
                <button
                  key={item.id}
                  className={`settings-nav-item${activeTab === item.id ? ' active' : ''}`}
                  onClick={() => setActiveTab(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </aside>
        )}

        {/* Content */}
        <div className="settings-content">
          <div className={`settings-content-header${isPeqPage ? ' settings-content-header--peq' : ''}`}>
            {isPeqPage ? (
              /* PEQ full-page header: back + title + close */
              <>
                <div className="settings-content-header-left">
                  <button
                    className="peq-back-btn"
                    onClick={() => setIsPeqExpanded(false)}
                    title="Back to Equalizer"
                  >
                    <ChevronLeft size={16} />
                    <span>Equalizer</span>
                  </button>
                  <div className="peq-page-title">
                    <FlaskConical size={14} />
                    Parametric EQ
                  </div>
                </div>
                <button className="icon-btn settings-close" onClick={onClose} title="Close">
                  <X size={18} />
                </button>
              </>
            ) : (
              /* Normal header */
              <>
                <div className="settings-content-header-left">
                  <h2>{NAV_ITEMS.find(i => i.id === activeTab)?.label}</h2>
                </div>
                <button className="icon-btn settings-close" onClick={onClose} title="Close">
                  <X size={18} />
                </button>
              </>
            )}
          </div>

          <div className="settings-body">
            {activeTab === 'general' && <GeneralTab />}
            {activeTab === 'equalizer' && (
              <EqualizerTab
                isExpanded={isPeqExpanded}
                onToggleExpand={() => setIsPeqExpanded(true)}
              />
            )}
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
    </div>,
    document.body
  );
}

// ── General tab ───────────────────────────────────────────────────────────────

const CLOSE_OPTIONS = [
  { value: 'tray', label: 'Minimize to tray' },
  { value: 'quit', label: 'Close the app' },
];

function SettingsDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = CLOSE_OPTIONS.find(o => o.value === value)!;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="settings-dropdown" ref={ref}>
      <button className="settings-dropdown-trigger" onClick={() => setOpen(o => !o)}>
        <span>{selected.label}</span>
        <ChevronDown size={14} className={`settings-dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="settings-dropdown-menu glass-panel">
          {CLOSE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className="settings-dropdown-item"
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span>{opt.label}</span>
              {opt.value === value && <Check size={13} className="settings-dropdown-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GeneralTab() {
  const { closeToTray, setCloseToTray } = useSettingsStore();

  return (
    <div className="settings-section-list">
      <div className="settings-about">
        <div className="settings-about-name">Viby</div>
        <div className="settings-about-desc">A modern, minimal local music player</div>
        <div className="settings-about-stack">Built with Tauri 2 · React · Rust</div>
      </div>

      <div className="settings-select-row">
        <label className="settings-select-label">Close button action</label>
        <SettingsDropdown
          value={closeToTray ? 'tray' : 'quit'}
          onChange={v => setCloseToTray(v === 'tray')}
        />
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

      <div className="cache-item">
        <div className="cache-item-icon"><Database size={18} /></div>
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
            <div className="cache-cleared-indicator"><CheckCircle2 size={16} /> Cleared</div>
          ) : (
            <button className="btn-cache-clear" onClick={onClearHistory}>
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      <div className="cache-item">
        <div className="cache-item-icon"><Image size={18} /></div>
        <div className="cache-item-info">
          <div className="cache-item-name">Artwork Cache</div>
          <div className="cache-item-desc">
            Album artwork decoded from audio files and held in memory for fast display.
            Automatically cleared when the app closes. Max 500 images at once.
          </div>
          <div className="cache-item-badge cache-item-badge--session">Session only · {artworkCacheSize} / 500 loaded</div>
        </div>
        <div className="cache-item-action">
          {clearedArtwork ? (
            <div className="cache-cleared-indicator"><CheckCircle2 size={16} /> Cleared</div>
          ) : (
            <button className="btn-cache-clear" onClick={onClearArtwork} disabled={artworkCacheSize === 0}>
              <Trash2 size={14} /> Clear
            </button>
          )}
        </div>
      </div>

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

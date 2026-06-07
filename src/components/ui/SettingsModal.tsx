import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Database, Image, CheckCircle2, Info, Settings, HardDrive, Sliders, FlaskConical, ChevronLeft, Palette, Keyboard } from 'lucide-react';
import { clearPlayHistory, setVolume as setRustVolume } from '../../utils/tauri';
import { clearArtworkCache, getArtworkCacheSize } from '../../utils/useArtwork';
import { useToastStore } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePlayerStore } from '../../stores/playerStore';
import EqualizerTab from './EqualizerTab';
import PeqPresetControls from './PeqPresetControls';
import Dropdown from './Dropdown';
import ThemePicker from './ThemePicker';
import './SettingsModal.css';

type Tab = 'general' | 'appearance' | 'equalizer' | 'cache' | 'shortcuts';

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general',    label: 'General',    icon: <Settings size={16} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
  { id: 'equalizer',  label: 'Equalizer',  icon: <Sliders size={16} /> },
  { id: 'cache',      label: 'Cache',      icon: <HardDrive size={16} /> },
  { id: 'shortcuts',  label: 'Shortcuts',  icon: <Keyboard size={16} /> },
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
                  <PeqPresetControls />
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
            {activeTab === 'appearance' && <AppearanceTab />}
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
            {activeTab === 'shortcuts' && <ShortcutsTab />}
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

const GPU_OPTIONS = [
  { value: 'enabled', label: 'Enabled (Default)' },
  { value: 'disabled', label: 'Disabled' },
];

const VOLUME_OPTIONS = [
  { value: 'linear', label: 'Linear (Default)' },
  { value: 'exponential', label: 'Exponential (Natural)' },
];

function GeneralTab() {
  const {
    closeToTray,
    setCloseToTray,
    gpuAcceleration,
    setGpuAcceleration,
    exponentialVolume,
    setExponentialVolume,
  } = useSettingsStore();

  return (
    <div className="settings-section-list">
      <div className="settings-about">
        <div className="settings-about-name">Viby</div>
        <div className="settings-about-desc">A modern, minimal local music player</div>
        <div className="settings-about-stack">Built with Tauri 2 · React · Rust</div>
      </div>

      <div className="settings-select-row">
        <label className="settings-select-label">Close button action</label>
        <Dropdown
          value={closeToTray ? 'tray' : 'quit'}
          options={CLOSE_OPTIONS}
          onChange={v => setCloseToTray(v === 'tray')}
        />
      </div>

      <div className="settings-select-row">
        <label className="settings-select-label">GPU Acceleration</label>
        <Dropdown
          value={gpuAcceleration ? 'enabled' : 'disabled'}
          options={GPU_OPTIONS}
          onChange={v => {
            const enabled = v === 'enabled';
            setGpuAcceleration(enabled);
            useToastStore.getState().addToast(
              'GPU acceleration updated. Restart the app to apply changes.',
              'success'
            );
          }}
        />
      </div>

      <div className="settings-select-row">
        <label className="settings-select-label">Volume slider curve</label>
        <Dropdown
          value={exponentialVolume ? 'exponential' : 'linear'}
          options={VOLUME_OPTIONS}
          onChange={v => {
            const expo = v === 'exponential';
            setExponentialVolume(expo);
            
            const currentVol = usePlayerStore.getState().volume;
            const finalVol = expo ? currentVol * currentVol * currentVol : currentVol;
            setRustVolume(finalVol).catch(err =>
              console.error('Failed to set volume on backend:', err)
            );
          }}
        />
      </div>

      <div className="settings-info-row">
        <Info size={14} className="text-tertiary" />
        <span>All data is stored locally on your device. Viby has no cloud sync and makes no network requests except to load fonts.</span>
      </div>
    </div>
  );
}

// ── Appearance tab ────────────────────────────────────────────────────────────

function AppearanceTab() {
  return (
    <div className="settings-section-list">
      <p className="settings-section-desc">Choose a color theme for the interface.</p>
      <ThemePicker />
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

// ── Shortcuts tab ─────────────────────────────────────────────────────────────

function ShortcutsTab() {
  const isMac = navigator.userAgent.toLowerCase().includes('mac');
  const modKey = isMac ? '⌘' : 'Ctrl';

  const shortcuts = [
    { category: 'Application', action: 'Quit App', keys: [modKey, 'Q'] },
    { category: 'Application', action: 'Close Active Modal', keys: ['Esc'] },
    { category: 'Playback', action: 'Play / Pause', keys: ['Space'] },
    { category: 'Playback', action: 'Next Track', keys: [modKey, '→'] },
    { category: 'Playback', action: 'Previous Track', keys: [modKey, '←'] },
    { category: 'Playback', action: 'Volume Up', keys: [modKey, '↑'] },
    { category: 'Playback', action: 'Volume Down', keys: [modKey, '↓'] },
    { category: 'Search & Navigation', action: 'Global Search Modal', keys: [modKey, 'K'] },
    { category: 'Search & Navigation', action: 'Focus Library Search', keys: ['/'] },
  ];

  return (
    <div className="settings-section-list">
      <p className="settings-section-desc">
        List of all keyboard shortcuts available when the application is active.
      </p>

      <div className="shortcuts-table-container">
        <table className="shortcuts-table">
          <thead>
            <tr>
              <th className="shortcuts-th">Category</th>
              <th className="shortcuts-th">Action</th>
              <th className="shortcuts-th">Key Combination</th>
            </tr>
          </thead>
          <tbody>
            {shortcuts.map((s, idx) => (
              <tr key={idx} className="shortcuts-tr">
                <td className="shortcuts-td" style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>
                  {s.category}
                </td>
                <td className="shortcuts-td" style={{ fontWeight: 600 }}>
                  {s.action}
                </td>
                <td className="shortcuts-td">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    {s.keys.map((k, kIdx) => (
                      <span key={kIdx} style={{ display: 'inline-flex', alignItems: 'center' }}>
                        {kIdx > 0 && <span style={{ color: 'var(--text-tertiary)', margin: '0 4px', fontSize: 'var(--font-size-xs)' }}>+</span>}
                        <kbd className="shortcuts-key-cap">{k}</kbd>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';
import { getPlatform } from '../../utils/platform';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePlayerStore } from '../../stores/playerStore';
import { hideToBackground } from '../../utils/tauri';
import './Titlebar.css';

const platform = getPlatform();

const backgroundCloseTitle =
  platform === 'macos'
    ? 'Hide to menu bar'
    : platform === 'windows'
      ? 'Hide to notification area'
      : 'Hide window and keep Viby running';

export default function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isHoveringControls, setIsHoveringControls] = useState(false);
  const appWindow = getCurrentWindow();
  const closeToTray = useSettingsStore(s => s.closeToTray);
  const showTitlebarEq = useSettingsStore(s => s.showTitlebarEq);
  const showTitlebarName = useSettingsStore(s => s.showTitlebarName);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const currentTrack = usePlayerStore(s => s.currentTrack);

  const handleClose = () => {
    if (closeToTray) {
      hideToBackground().catch((err) => console.error('Failed to hide to background:', err));
      return;
    }
    appWindow.close();
  };

  useEffect(() => {
    const checkMaximized = async () => {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    };
    checkMaximized();

    const unlisten = appWindow.onResized(() => {
      checkMaximized();
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const renderBrand = () => (
    <div className="titlebar-brand" data-tauri-drag-region>
      {showTitlebarName && <span className="app-title" data-tauri-drag-region>Viby</span>}
      {currentTrack && showTitlebarEq && showTitlebarName && (
        <div
          className={`titlebar-eq ${isPlaying ? 'playing' : ''}`}
          data-tauri-drag-region
          title={isPlaying ? 'Playing' : 'Paused'}
        >
          <span className="titlebar-eq-bar" />
          <span className="titlebar-eq-bar" />
          <span className="titlebar-eq-bar" />
        </div>
      )}
    </div>
  );

  if (platform === 'macos') {
    return (
      <div data-tauri-drag-region className="titlebar">
        <div
          className="titlebar-left traffic-lights"
          data-tauri-no-drag
          onMouseEnter={() => setIsHoveringControls(true)}
          onMouseLeave={() => setIsHoveringControls(false)}
        >
          <button className="mac-btn close-btn" onClick={handleClose} title={closeToTray ? backgroundCloseTitle : 'Close'}>
            {isHoveringControls && <X size={10} />}
          </button>
          <button className="mac-btn minimize-btn" onClick={() => appWindow.minimize()} title="Minimize">
            {isHoveringControls && <Minus size={10} />}
          </button>
          <button className="mac-btn maximize-btn" onClick={() => appWindow.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
            {isHoveringControls && <Square size={8} />}
          </button>
        </div>

        <div className="titlebar-center" data-tauri-drag-region>
          {renderBrand()}
        </div>

        <div className="titlebar-right" data-tauri-drag-region />
      </div>
    );
  }

  // Windows / Linux — controls on the right
  return (
    <div data-tauri-drag-region className="titlebar titlebar-win">
      <div className="titlebar-win-left-spacer" data-tauri-drag-region />

      <div className="titlebar-center" data-tauri-drag-region>
        {renderBrand()}
      </div>

      <div className="titlebar-win-controls" data-tauri-no-drag>
        <button className="win-btn minimize-win" onClick={() => appWindow.minimize()} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="win-btn maximize-win" onClick={() => appWindow.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
          <Square size={12} />
        </button>
        <button className="win-btn close-win" onClick={handleClose} title={closeToTray ? backgroundCloseTitle : 'Close'}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

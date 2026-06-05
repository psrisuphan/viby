import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';
import { getPlatform } from '../../utils/platform';
import './Titlebar.css';

const platform = getPlatform();

export default function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isHoveringControls, setIsHoveringControls] = useState(false);
  const appWindow = getCurrentWindow();

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

  if (platform === 'macos') {
    return (
      <div data-tauri-drag-region className="titlebar">
        <div
          className="titlebar-left traffic-lights"
          data-tauri-no-drag
          onMouseEnter={() => setIsHoveringControls(true)}
          onMouseLeave={() => setIsHoveringControls(false)}
        >
          <button className="mac-btn close-btn" onClick={() => appWindow.close()} title="Close">
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
          <span className="app-title" data-tauri-drag-region>Viby</span>
        </div>

        <div className="titlebar-right" data-tauri-drag-region />
      </div>
    );
  }

  // Windows / Linux — controls on the right
  return (
    <div data-tauri-drag-region className="titlebar titlebar-win">
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="app-title">Viby</span>
      </div>

      <div className="titlebar-win-controls" data-tauri-no-drag>
        <button className="win-btn minimize-win" onClick={() => appWindow.minimize()} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="win-btn maximize-win" onClick={() => appWindow.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
          <Square size={12} />
        </button>
        <button className="win-btn close-win" onClick={() => appWindow.close()} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

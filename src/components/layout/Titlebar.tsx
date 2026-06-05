import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';
import './Titlebar.css';

export default function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
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

  return (
    <div data-tauri-drag-region className="titlebar">
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="app-title" data-tauri-drag-region>Viby</span>
      </div>
      
      <div className="titlebar-center" data-tauri-drag-region>
        {/* Optional: search bar or currently playing text could go here */}
      </div>

      <div className="titlebar-right" data-tauri-no-drag>
        <button 
          className="titlebar-btn" 
          onClick={() => appWindow.minimize()}
          title="Minimize"
          data-tauri-no-drag
        >
          <Minus size={16} />
        </button>
        <button 
          className="titlebar-btn" 
          onClick={() => appWindow.toggleMaximize()}
          title={isMaximized ? "Restore" : "Maximize"}
          data-tauri-no-drag
        >
          <Square size={14} />
        </button>
        <button 
          className="titlebar-btn close-btn" 
          onClick={() => appWindow.close()}
          title="Close"
          data-tauri-no-drag
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

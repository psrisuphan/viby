import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  isDanger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    // Close on escape
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Use mousedown instead of click to capture earlier
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose]);

  // Prevent menu from going off-screen
  const [style, setStyle] = useState({ top: y, left: x, opacity: 0 });
  
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let safeX = x;
      let safeY = y;
      
      if (x + rect.width > viewportWidth) {
        safeX = viewportWidth - rect.width - 8;
      }
      
      if (y + rect.height > viewportHeight) {
        safeY = viewportHeight - rect.height - 8;
      }
      
      setStyle({ top: safeY, left: safeX, opacity: 1 });
    }
  }, [x, y]);

  return createPortal(
    <div
      className="context-menu glass-panel"
      ref={menuRef}
      style={{
        position: 'fixed',
        top: style.top,
        left: style.left,
        opacity: style.opacity,
        zIndex: 9999,
      }}
    >
      {items.map((item, idx) => (
        <button
          key={idx}
          className={`context-menu-item ${item.isDanger ? 'danger' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            item.onClick();
            onClose();
          }}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

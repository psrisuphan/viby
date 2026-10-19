import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ContextMenu.css";

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
  returnFocusTo?: HTMLElement;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  returnFocusTo,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  const moveFocus = (index: number) => {
    if (items.length === 0) return;
    const nextIndex = (index + items.length) % items.length;
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  // Close when clicking outside
  useEffect(() => {
    const handleClick = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Close on escape
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        window.requestAnimationFrame(() => {
          if (returnFocusTo?.isConnected) returnFocusTo.focus();
        });
      }
    };

    // Use pointerdown instead of click to capture mouse, touch, and pen earlier.
    document.addEventListener("pointerdown", handleClick);
    document.addEventListener("keydown", handleKeydown);

    return () => {
      document.removeEventListener("pointerdown", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose, returnFocusTo]);

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
      role="menu"
      aria-label="Song actions"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(activeIndex + 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(activeIndex - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          moveFocus(0);
        } else if (event.key === "End") {
          event.preventDefault();
          moveFocus(items.length - 1);
        }
      }}
      style={{
        position: "fixed",
        top: style.top,
        left: style.left,
        opacity: style.opacity,
        zIndex: 9999,
      }}
    >
      {items.map((item, idx) => (
        <button
          key={idx}
          ref={(element) => {
            itemRefs.current[idx] = element;
          }}
          className={`context-menu-item ${item.isDanger ? "danger" : ""}`}
          type="button"
          role="menuitem"
          tabIndex={activeIndex === idx ? 0 : -1}
          onFocus={() => setActiveIndex(idx)}
          onClick={(e) => {
            e.stopPropagation();
            if (returnFocusTo?.isConnected) {
              returnFocusTo.focus({ preventScroll: true });
            }
            try {
              item.onClick();
            } finally {
              onClose();
            }
          }}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

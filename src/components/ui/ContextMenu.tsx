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
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

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
    // biome-ignore lint/a11y/useSemanticElements: song actions are a grouped button list, and a fieldset would inherit browser form styling
    <div
      className="context-menu glass-panel"
      ref={menuRef}
      role="group"
      aria-label="Song actions"
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
          ref={idx === 0 ? firstItemRef : undefined}
          className={`context-menu-item ${item.isDanger ? "danger" : ""}`}
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
    document.body,
  );
}

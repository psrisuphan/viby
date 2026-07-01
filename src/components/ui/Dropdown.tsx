import { useEffect, useRef, useState, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import './Dropdown.css';

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const OFFSCREEN: React.CSSProperties = {
  position: 'fixed',
  top: -9999,
  left: -9999,
  pointerEvents: 'none',
  zIndex: 9999,
};

export default function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select…',
  className,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find(o => o.value === value);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>(OFFSCREEN);

  const focusOption = (index: number) => {
    const wrappedIndex = (index + options.length) % options.length;
    optionRefs.current[wrappedIndex]?.focus();
  };

  const openAndFocus = (index: number) => {
    setOpen(true);
    requestAnimationFrame(() => focusOption(index));
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) {
      setMenuStyle(OFFSCREEN);
      return;
    }

    const MENU_GAP = 6;

    const updatePosition = () => {
      if (!triggerRef.current || !menuRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuRect = menuRef.current.getBoundingClientRect();

      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;
      const openUp = spaceBelow < menuRect.height + MENU_GAP && spaceAbove > spaceBelow;

      const menuTop = openUp
        ? triggerRect.top - menuRect.height - MENU_GAP
        : triggerRect.bottom + MENU_GAP;

      const maxLeft = window.innerWidth - menuRect.width;
      const menuLeft = Math.min(triggerRect.left, Math.max(0, maxLeft));

      setMenuStyle({
        position: 'fixed',
        top: menuTop,
        left: menuLeft,
        width: triggerRect.width,
        pointerEvents: 'none',
        zIndex: 9999,
      });
    };

    updatePosition();

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const clickedTriggerOrContainer = ref.current && ref.current.contains(e.target as Node);
      const clickedMenu = menuRef.current && menuRef.current.contains(e.target as Node);
      if (!clickedTriggerOrContainer && !clickedMenu) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAndFocus(event.key === 'ArrowDown' ? selectedIndex : options.length - 1);
    }
  };

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <div className={`settings-dropdown${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-dropdown-trigger"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className={`settings-dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {open && !disabled && createPortal(
        <div
          ref={menuRef}
          className={`settings-dropdown ${className || ''}`}
          style={menuStyle}
        >
          <div className="settings-dropdown-menu" role="listbox" style={{ pointerEvents: 'auto' }}>
            {options.map((opt, index) => (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={`settings-dropdown-item${opt.value === value ? ' selected' : ''}`}
                tabIndex={index === selectedIndex ? 0 : -1}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {opt.value === value && <Check size={14} className="settings-dropdown-check" />}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

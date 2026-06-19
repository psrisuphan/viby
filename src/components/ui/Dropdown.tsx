import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find(o => o.value === value);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));

  const focusOption = (index: number) => {
    const wrappedIndex = (index + options.length) % options.length;
    optionRefs.current[wrappedIndex]?.focus();
  };

  const openAndFocus = (index: number) => {
    setOpen(true);
    requestAnimationFrame(() => focusOption(index));
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
      {open && !disabled && (
        <div className="settings-dropdown-menu" role="listbox">
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
      )}
    </div>
  );
}

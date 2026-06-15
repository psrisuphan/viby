import { useEffect, useRef, useState } from 'react';
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
  const selected = options.find(o => o.value === value);

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

  return (
    <div className={`settings-dropdown${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        type="button"
        className="settings-dropdown-trigger"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      >
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className={`settings-dropdown-chevron${open ? ' open' : ''}`} />
      </button>
      {open && !disabled && (
        <div className="settings-dropdown-menu glass-panel">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="settings-dropdown-item"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
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

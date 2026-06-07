import { Check } from 'lucide-react';
import { THEMES, useThemeStore, applyTheme, type ThemeId } from '../../stores/themeStore';
import './ThemePicker.css';

export default function ThemePicker() {
  const { theme, setTheme } = useThemeStore();

  const handleSelect = (id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  };

  return (
    <div className="theme-picker">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={`theme-swatch${theme === t.id ? ' theme-swatch--active' : ''}`}
          onClick={() => handleSelect(t.id)}
          title={t.name}
        >
          <div
            className="theme-swatch-preview"
            style={{ background: t.preview.bg }}
          >
            <div
              className="theme-swatch-surface"
              style={{ background: t.preview.surface }}
            />
            <div
              className="theme-swatch-accent"
              style={{ background: t.preview.accent }}
            />
            {theme === t.id && (
              <div className="theme-swatch-check">
                <Check size={12} strokeWidth={3} />
              </div>
            )}
          </div>
          <span className="theme-swatch-name">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

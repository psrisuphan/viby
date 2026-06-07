import { Check } from 'lucide-react';
import { THEMES, THEME_GROUPS, useThemeStore, applyTheme, type ThemeId, type ThemeDefinition } from '../../stores/themeStore';
import './ThemePicker.css';

const GROUP_ORDER = ['default', 'light', 'catppuccin', 'dark'] as const;

export default function ThemePicker() {
  const { theme, setTheme } = useThemeStore();

  const handleSelect = (id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  };

  const groups = GROUP_ORDER.map(group => ({
    key: group,
    label: THEME_GROUPS[group],
    themes: THEMES.filter(t => t.group === group),
  })).filter(g => g.themes.length > 0);

  return (
    <div className="theme-picker">
      {groups.map(({ key, label, themes }) => (
        <div key={key} className="theme-group">
          <div className="theme-group-label">{label}</div>
          <div className="theme-group-grid">
            {themes.map((t: ThemeDefinition) => (
              <ThemeSwatch
                key={t.id}
                theme={t}
                active={theme === t.id}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThemeSwatch({
  theme: t,
  active,
  onSelect,
}: {
  theme: ThemeDefinition;
  active: boolean;
  onSelect: (id: ThemeId) => void;
}) {
  return (
    <button
      className={`theme-swatch${active ? ' theme-swatch--active' : ''}`}
      onClick={() => onSelect(t.id)}
      title={t.name}
    >
      <div className="theme-swatch-preview" style={{ background: t.preview.bg }}>
        <div className="theme-swatch-surface" style={{ background: t.preview.surface }} />
        <div className="theme-swatch-accent"  style={{ background: t.preview.accent }} />
        {active && (
          <div className="theme-swatch-check" style={{ background: t.preview.accent, color: t.preview.bg }}>
            <Check size={11} strokeWidth={3} />
          </div>
        )}
      </div>
      <span className="theme-swatch-name">{t.name}</span>
    </button>
  );
}

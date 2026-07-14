import { Check } from 'lucide-react';
import { THEMES, THEME_GROUPS, useThemeStore, applyTheme, type ThemeId, type ThemeDefinition } from '../../stores/themeStore';
import './ThemePicker.css';

const GROUP_ORDER = ['light', 'dark'] as const;
const GROUPS = GROUP_ORDER.map(group => ({
  key: group,
  label: THEME_GROUPS[group],
  themes: THEMES.filter(t => t.group === group),
})).filter(g => g.themes.length > 0);

export default function ThemePicker() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const handleSelect = (id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  };

  return (
    <div className="theme-picker">
      {GROUPS.map(({ key, label, themes }) => (
        <div key={key} className="theme-group" role="group" aria-label={`${label} themes`}>
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
      type="button"
      className={`theme-swatch${active ? ' theme-swatch--active' : ''}`}
      onClick={() => onSelect(t.id)}
      aria-pressed={active}
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

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeId =
  | 'viby'
  // Catppuccin family
  | 'catppuccin-latte'
  | 'catppuccin-frappe'
  | 'catppuccin-macchiato'
  | 'catppuccin-mocha'
  // Light themes
  | 'tokyo-night-day'
  | 'rose-pine-dawn'
  | 'gruvbox-light'
  | 'ayu-light'
  | 'everforest-light'
  | 'github-light'
  // Dark themes
  | 'tokyo-night'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'one-dark-pro'
  | 'rose-pine'
  | 'night-owl'
  | 'everforest'
  | 'ayu-dark'
  | 'ayu-mirage'
  | 'iceberg'
  | 'kanagawa'
  | 'github-dark'
  | 'material-ocean'
  | 'monokai-pro';

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  group: 'dark' | 'light';
  preview: {
    bg: string;
    surface: string;
    accent: string;
  };
}

export const THEMES: ThemeDefinition[] = [
  // ── Default ──────────────────────────────────────────────
  {
    id: 'viby',
    name: 'Viby',
    group: 'dark',
    preview: { bg: 'hsl(220,8%,6%)', surface: 'hsl(220,7%,13%)', accent: 'hsl(125,75%,70%)' },
  },

  // ── Catppuccin family ─────────────────────────────────────
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    group: 'light',
    preview: { bg: '#eff1f5', surface: '#ccd0da', accent: '#8839ef' },
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    group: 'dark',
    preview: { bg: '#303446', surface: '#414559', accent: '#ca9ee6' },
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    group: 'dark',
    preview: { bg: '#24273a', surface: '#363a4f', accent: '#c6a0f6' },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    group: 'dark',
    preview: { bg: '#1e1e2e', surface: '#313244', accent: '#cba6f7' },
  },

  // ── Light themes ─────────────────────────────────────────
  {
    id: 'tokyo-night-day',
    name: 'Tokyo Night Day',
    group: 'light',
    preview: { bg: '#e6e7ed', surface: '#d6d8df', accent: '#2959aa' },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    group: 'light',
    preview: { bg: '#faf4ed', surface: '#fffaf3', accent: '#907aa9' },
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    group: 'light',
    preview: { bg: '#fbf1c7', surface: '#ebdbb2', accent: '#d79921' },
  },
  {
    id: 'ayu-light',
    name: 'Ayu Light',
    group: 'light',
    preview: { bg: '#fcfcfc', surface: '#f8f9fa', accent: '#f29718' },
  },
  {
    id: 'everforest-light',
    name: 'Everforest Light',
    group: 'light',
    preview: { bg: '#fdf6e3', surface: '#f4f0d9', accent: '#8da101' },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    group: 'light',
    preview: { bg: '#ffffff', surface: '#f6f8fa', accent: '#0969da' },
  },

  // ── Dark themes ───────────────────────────────────────────
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    group: 'dark',
    preview: { bg: '#1a1b26', surface: '#1e202e', accent: '#7aa2f7' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    group: 'dark',
    preview: { bg: '#282a36', surface: '#343746', accent: '#bd93f9' },
  },
  {
    id: 'nord',
    name: 'Nord',
    group: 'dark',
    preview: { bg: '#2e3440', surface: '#434c5e', accent: '#88c0d0' },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    group: 'dark',
    preview: { bg: '#1d2021', surface: '#282828', accent: '#fabd2f' },
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    group: 'dark',
    preview: { bg: '#282c34', surface: '#2c313a', accent: '#61afef' },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    group: 'dark',
    preview: { bg: '#191724', surface: '#26233a', accent: '#c4a7e7' },
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    group: 'dark',
    preview: { bg: '#011627', surface: '#0d2137', accent: '#7fdbca' },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    group: 'dark',
    preview: { bg: '#2d353b', surface: '#3d484d', accent: '#a7c080' },
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    group: 'dark',
    preview: { bg: '#10141c', surface: '#1a2133', accent: '#e6b450' },
  },
  {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    group: 'dark',
    preview: { bg: '#242936', surface: '#2d3347', accent: '#ffcc66' },
  },
  {
    id: 'iceberg',
    name: 'Iceberg',
    group: 'dark',
    preview: { bg: '#161821', surface: '#1e2132', accent: '#84a0c6' },
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa Wave',
    group: 'dark',
    preview: { bg: '#1f1f28', surface: '#2a2a37', accent: '#7e9cd8' },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    group: 'dark',
    preview: { bg: '#0d1117', surface: '#161b22', accent: '#2f81f7' },
  },
  {
    id: 'material-ocean',
    name: 'Material Deep Ocean',
    group: 'dark',
    preview: { bg: '#0f111a', surface: '#181a1f', accent: '#84ffff' },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    group: 'dark',
    preview: { bg: '#2d2a2e', surface: '#3a3741', accent: '#a9dc76' },
  },
];

export const THEME_GROUPS = {
  light: 'Light',
  dark: 'Dark',
} as const;

const THEME_STORAGE_KEY = 'viby-theme';
const DEFAULT_THEME: ThemeId = 'viby';

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
}

export function getStoredTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined = getLocalStorage()
): ThemeId {
  if (!storage) return DEFAULT_THEME;

  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    if (!stored) return DEFAULT_THEME;

    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_THEME;

    const state = 'state' in parsed ? (parsed as { state?: unknown }).state : undefined;
    const persistedTheme =
      state && typeof state === 'object'
        ? (state as { theme?: unknown }).theme
        : (parsed as { theme?: unknown }).theme;

    return isThemeId(persistedTheme) ? persistedTheme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME,
      setTheme: (theme) => set({ theme }),
    }),
    { name: THEME_STORAGE_KEY }
  )
);

export function applyTheme(theme: ThemeId) {
  if (typeof document === 'undefined') return;

  if (theme === 'viby') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function getThemeAccent(theme: ThemeId) {
  return THEMES.find((item) => item.id === theme)?.preview.accent ?? THEMES[0].preview.accent;
}

export function initializeTheme() {
  const theme = getStoredTheme();
  applyTheme(theme);

  if (useThemeStore.getState().theme !== theme) {
    useThemeStore.setState({ theme });
  }

  return theme;
}

function getLocalStorage(): Pick<Storage, 'getItem'> | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

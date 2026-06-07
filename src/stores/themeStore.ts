import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeId =
  | 'viby'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'one-dark-pro'
  | 'rose-pine';

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  preview: {
    bg: string;
    surface: string;
    accent: string;
  };
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'viby',
    name: 'Viby',
    preview: { bg: 'hsl(220, 8%, 6%)', surface: 'hsl(220, 7%, 13%)', accent: 'hsl(125, 75%, 70%)' },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    preview: { bg: '#1a1b26', surface: '#24283b', accent: '#7aa2f7' },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    preview: { bg: '#1e1e2e', surface: '#313244', accent: '#cba6f7' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    preview: { bg: '#282a36', surface: '#343746', accent: '#bd93f9' },
  },
  {
    id: 'nord',
    name: 'Nord',
    preview: { bg: '#2e3440', surface: '#3b4252', accent: '#88c0d0' },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    preview: { bg: '#1d2021', surface: '#282828', accent: '#fabd2f' },
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    preview: { bg: '#282c34', surface: '#2c313a', accent: '#61afef' },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    preview: { bg: '#191724', surface: '#26233a', accent: '#c4a7e7' },
  },
];

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'viby',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'viby-theme' }
  )
);

export function applyTheme(theme: ThemeId) {
  if (theme === 'viby') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

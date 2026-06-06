import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  closeToTray: boolean;
  setCloseToTray: (value: boolean) => void;
  miniPlayerAlwaysOnTop: boolean;
  setMiniPlayerAlwaysOnTop: (value: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      closeToTray: true,
      setCloseToTray: (value) => set({ closeToTray: value }),
      miniPlayerAlwaysOnTop: true,
      setMiniPlayerAlwaysOnTop: (value) => set({ miniPlayerAlwaysOnTop: value }),
    }),
    { name: 'viby-settings' }
  )
);

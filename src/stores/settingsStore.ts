import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const EQ_BAND_COUNT = 10;

export interface EqPreset {
  name: string;
  preamp: number;
  gains: number[];
}

interface SettingsState {
  closeToTray: boolean;
  setCloseToTray: (value: boolean) => void;
  miniPlayerAlwaysOnTop: boolean;
  setMiniPlayerAlwaysOnTop: (value: boolean) => void;

  // Equalizer
  eqEnabled: boolean;
  setEqEnabled: (value: boolean) => void;
  eqPreamp: number;                 // dB
  setEqPreamp: (value: number) => void;
  eqGains: number[];                // length 10, dB
  setEqGains: (value: number[]) => void;
  eqPresets: EqPreset[];            // user-saved presets
  addEqPreset: (preset: EqPreset) => void;
  removeEqPreset: (name: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      closeToTray: true,
      setCloseToTray: (value) => set({ closeToTray: value }),
      miniPlayerAlwaysOnTop: true,
      setMiniPlayerAlwaysOnTop: (value) => set({ miniPlayerAlwaysOnTop: value }),

      eqEnabled: false,
      setEqEnabled: (value) => set({ eqEnabled: value }),
      eqPreamp: 0,
      setEqPreamp: (value) => set({ eqPreamp: value }),
      eqGains: Array(EQ_BAND_COUNT).fill(0),
      setEqGains: (value) => set({ eqGains: value }),
      eqPresets: [],
      addEqPreset: (preset) => set((s) => ({
        eqPresets: [...s.eqPresets.filter((p) => p.name !== preset.name), preset],
      })),
      removeEqPreset: (name) => set((s) => ({
        eqPresets: s.eqPresets.filter((p) => p.name !== name),
      })),
    }),
    { name: 'viby-settings' }
  )
);

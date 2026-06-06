import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const EQ_BAND_COUNT = 10;
export const DEFAULT_Q = 1.4;

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
  eqCustomQ: boolean;               // whether the user customizes Q
  setEqCustomQ: (value: boolean) => void;
  eqQ: number;                      // band Q when custom
  setEqQ: (value: number) => void;
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
      eqCustomQ: false,
      setEqCustomQ: (value) => set({ eqCustomQ: value }),
      eqQ: DEFAULT_Q,
      setEqQ: (value) => set({ eqQ: value }),
    }),
    { name: 'viby-settings' }
  )
);

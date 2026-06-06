import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const EQ_BAND_COUNT = 10;
export const PEQ_BAND_COUNT = 8;

export interface EqPreset {
  name: string;
  preamp: number;
  gains: number[];
}

// filter_type: 0=Peaking, 1=LowShelf, 2=HighShelf, 3=LowPass, 4=HighPass
export interface PeqBand {
  enabled: boolean;
  filterType: 0 | 1 | 2 | 3 | 4;
  freq: number;   // Hz, 20–20000
  gain: number;   // dB, -12 to +12 (ignored for LP/HP)
  q: number;      // 0.1–10
}

const DEFAULT_PEQ_BANDS: PeqBand[] = [
  { enabled: true, filterType: 1, freq: 100,   gain: 0, q: 0.707 },
  { enabled: true, filterType: 0, freq: 200,   gain: 0, q: 1.0   },
  { enabled: true, filterType: 0, freq: 500,   gain: 0, q: 1.0   },
  { enabled: true, filterType: 0, freq: 1000,  gain: 0, q: 1.0   },
  { enabled: true, filterType: 0, freq: 2000,  gain: 0, q: 1.0   },
  { enabled: true, filterType: 0, freq: 4000,  gain: 0, q: 1.0   },
  { enabled: true, filterType: 0, freq: 8000,  gain: 0, q: 1.0   },
  { enabled: true, filterType: 2, freq: 12000, gain: 0, q: 0.707 },
];

interface SettingsState {
  closeToTray: boolean;
  setCloseToTray: (value: boolean) => void;
  miniPlayerAlwaysOnTop: boolean;
  setMiniPlayerAlwaysOnTop: (value: boolean) => void;

  // Equalizer (shared)
  eqEnabled: boolean;
  setEqEnabled: (value: boolean) => void;
  eqMode: 'graphic' | 'parametric';
  setEqMode: (mode: 'graphic' | 'parametric') => void;

  // Graphic EQ
  eqPreamp: number;
  setEqPreamp: (value: number) => void;
  eqGains: number[];
  setEqGains: (value: number[]) => void;
  eqPresets: EqPreset[];
  addEqPreset: (preset: EqPreset) => void;
  removeEqPreset: (name: string) => void;

  // Parametric EQ
  peqBands: PeqBand[];
  setPeqBand: (index: number, patch: Partial<PeqBand>) => void;
  setPeqBands: (bands: PeqBand[]) => void;
  addPeqBand: () => void;
  removePeqBand: (index: number) => void;
  sortPeqBands: () => void;
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
      eqMode: 'graphic',
      setEqMode: (mode) => set({ eqMode: mode }),

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

      peqBands: DEFAULT_PEQ_BANDS,
      setPeqBand: (index, patch) => set((s) => {
        const next = s.peqBands.slice();
        next[index] = { ...next[index], ...patch };
        return { peqBands: next };
      }),
      setPeqBands: (bands) => set({ peqBands: [...bands].sort((a, b) => a.freq - b.freq) }),
      addPeqBand: () => set((s) => ({
        peqBands: [...s.peqBands, { enabled: true, filterType: 0 as const, freq: 1000, gain: 0, q: 1.0 }].sort((a, b) => a.freq - b.freq),
      })),
      removePeqBand: (index) => set((s) => ({
        peqBands: s.peqBands.filter((_, i) => i !== index),
      })),
      sortPeqBands: () => set((s) => ({
        peqBands: [...s.peqBands].sort((a, b) => a.freq - b.freq),
      })),
    }),
    { name: 'viby-settings' }
  )
);

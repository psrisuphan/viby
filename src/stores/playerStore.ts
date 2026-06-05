// ============================================
// Viby — Player Store (Zustand)
// Manages playback state, volume, progress
// ============================================

import { create } from 'zustand';
import type { Track, RepeatMode } from '../types';

interface PlayerState {
  // Playback state
  isPlaying: boolean;
  currentTrack: Track | null;
  positionSecs: number;
  durationSecs: number;

  // Controls
  volume: number;
  isMuted: boolean;
  previousVolume: number;
  shuffle: boolean;
  repeatMode: RepeatMode;

  // Actions
  setIsPlaying: (playing: boolean) => void;
  setCurrentTrack: (track: Track | null) => void;
  setPosition: (secs: number) => void;
  setDuration: (secs: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  // Initial state
  isPlaying: false,
  currentTrack: null,
  positionSecs: 0,
  durationSecs: 0,
  volume: 0.8,
  isMuted: false,
  previousVolume: 0.8,
  shuffle: false,
  repeatMode: 'off',

  // Actions
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTrack: (track) => set({ currentTrack: track, positionSecs: 0 }),
  setPosition: (secs) => set({ positionSecs: secs }),
  setDuration: (secs) => set({ durationSecs: secs }),

  setVolume: (vol) => set({
    volume: Math.max(0, Math.min(1, vol)),
    isMuted: vol === 0,
  }),

  toggleMute: () => {
    const { isMuted, volume, previousVolume } = get();
    if (isMuted) {
      set({ isMuted: false, volume: previousVolume || 0.8 });
    } else {
      set({ isMuted: true, previousVolume: volume, volume: 0 });
    }
  },

  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

  cycleRepeat: () => set((s) => {
    const modes: RepeatMode[] = ['off', 'all', 'one'];
    const idx = modes.indexOf(s.repeatMode);
    return { repeatMode: modes[(idx + 1) % modes.length] };
  }),
}));

// ============================================
// Viby — Queue Store (Zustand)
// Manages the playback queue, perfectly synced with Rust backend
// ============================================

import { create } from 'zustand';
import type { Track, QueuePayload } from '../types';

interface QueueState {
  tracks: Track[];
  currentIndex: number | null;

  // Actions
  setQueueState: (payload: QueuePayload) => void;
  setCurrentIndex: (currentIndex: number | null) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  tracks: [],
  currentIndex: null,

  setQueueState: (payload) => set({
    tracks: payload.tracks,
    currentIndex: payload.current_index
  }),
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
}));

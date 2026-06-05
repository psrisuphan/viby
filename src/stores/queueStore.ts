// ============================================
// Viby — Queue Store (Zustand)
// Manages the playback queue
// ============================================

import { create } from 'zustand';
import type { Track } from '../types';

interface QueueState {
  tracks: Track[];
  currentIndex: number;

  // Actions
  setQueue: (tracks: Track[]) => void;
  clearQueue: () => void;
  addToQueue: (track: Track) => void;
  addNext: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  setCurrentIndex: (index: number) => void;
  moveItem: (fromIndex: number, toIndex: number) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  tracks: [],
  currentIndex: -1,

  setQueue: (tracks) => set({ tracks, currentIndex: tracks.length > 0 ? 0 : -1 }),
  
  clearQueue: () => set({ tracks: [], currentIndex: -1 }),
  
  addToQueue: (track) => set((state) => ({
    tracks: [...state.tracks, track],
    currentIndex: state.currentIndex === -1 ? 0 : state.currentIndex
  })),
  
  addNext: (track) => set((state) => {
    if (state.tracks.length === 0) {
      return { tracks: [track], currentIndex: 0 };
    }
    const newTracks = [...state.tracks];
    const insertIdx = state.currentIndex + 1;
    newTracks.splice(insertIdx, 0, track);
    return { tracks: newTracks };
  }),
  
  removeFromQueue: (index) => set((state) => {
    const newTracks = state.tracks.filter((_, i) => i !== index);
    let newIndex = state.currentIndex;
    if (index < state.currentIndex) {
      newIndex--;
    } else if (index === state.currentIndex) {
      // If we removed the current track, stay at the same index
      // unless it was the last track, then go to -1
      if (newTracks.length === 0) newIndex = -1;
      else if (newIndex >= newTracks.length) newIndex = 0;
    }
    return { tracks: newTracks, currentIndex: newIndex };
  }),
  
  setCurrentIndex: (index) => set({ currentIndex: index }),
  
  moveItem: (fromIndex, toIndex) => set((state) => {
    const newTracks = [...state.tracks];
    const [item] = newTracks.splice(fromIndex, 1);
    newTracks.splice(toIndex, 0, item);
    
    // Update currentIndex if necessary
    let newIndex = state.currentIndex;
    if (state.currentIndex === fromIndex) {
      newIndex = toIndex;
    } else if (state.currentIndex > fromIndex && state.currentIndex <= toIndex) {
      newIndex--;
    } else if (state.currentIndex < fromIndex && state.currentIndex >= toIndex) {
      newIndex++;
    }
    
    return { tracks: newTracks, currentIndex: newIndex };
  }),
}));

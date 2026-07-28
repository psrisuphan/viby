// ============================================
// Viby — Library Store (Zustand)
// Manages library data (tracks, albums, etc.)
// ============================================

import { create } from 'zustand';
import type { Track, Album, Artist, Playlist } from '../types';

interface LibraryState {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  isLoaded: boolean;
  
  isScanning: boolean;
  scanProgress: number; // 0-100
  scanStatusText: string;

  // Actions
  setTracks: (tracks: Track[]) => void;
  setAlbums: (albums: Album[]) => void;
  setArtists: (artists: Artist[]) => void;
  setPlaylists: (playlists: Playlist[]) => void;
  setLibraryData: (data: Pick<LibraryState, 'tracks' | 'albums' | 'artists' | 'playlists'>) => void;
  setLibraryLoaded: () => void;
  
  setScanState: (isScanning: boolean, progress: number, text: string) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  tracks: [],
  albums: [],
  artists: [],
  playlists: [],
  isLoaded: false,
  
  isScanning: false,
  scanProgress: 0,
  scanStatusText: '',

  setTracks: (tracks) => set({ tracks }),
  setAlbums: (albums) => set({ albums }),
  setArtists: (artists) => set({ artists }),
  setPlaylists: (playlists) => set({ playlists }),
  setLibraryData: (data) => set({ ...data, isLoaded: true }),
  setLibraryLoaded: () => set({ isLoaded: true }),
  
  setScanState: (isScanning, progress, text) => set({
    isScanning,
    scanProgress: progress,
    scanStatusText: text
  }),
}));

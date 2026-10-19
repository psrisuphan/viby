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
  isLoading: boolean;
  libraryLoadError: string | null;
  
  isScanning: boolean;
  scanProgress: number; // 0-100
  scanStatusText: string;
  scanError: string | null;
  scanNotice: string | null;

  // Actions
  setTracks: (tracks: Track[]) => void;
  setAlbums: (albums: Album[]) => void;
  setArtists: (artists: Artist[]) => void;
  setPlaylists: (playlists: Playlist[]) => void;
  setLibraryData: (data: Pick<LibraryState, 'tracks' | 'albums' | 'artists' | 'playlists'>) => void;
  setLibraryLoading: () => void;
  setLibraryLoadError: (error: string | null) => void;
  
  setScanState: (
    isScanning: boolean,
    progress: number,
    text: string,
    error?: string | null,
    notice?: string | null,
  ) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  tracks: [],
  albums: [],
  artists: [],
  playlists: [],
  isLoaded: false,
  isLoading: true,
  libraryLoadError: null,
  
  isScanning: false,
  scanProgress: 0,
  scanStatusText: '',
  scanError: null,
  scanNotice: null,

  setTracks: (tracks) => set({ tracks }),
  setAlbums: (albums) => set({ albums }),
  setArtists: (artists) => set({ artists }),
  setPlaylists: (playlists) => set({ playlists }),
  setLibraryData: (data) => set({ ...data, isLoaded: true, isLoading: false, libraryLoadError: null }),
  setLibraryLoading: () => set({ isLoading: true, libraryLoadError: null }),
  setLibraryLoadError: (libraryLoadError) => set({ libraryLoadError, isLoading: false }),
  
  setScanState: (isScanning, progress, text, scanError = null, scanNotice = null) => set({
    isScanning,
    scanProgress: progress,
    scanStatusText: text,
    scanError,
    scanNotice,
  }),
}));

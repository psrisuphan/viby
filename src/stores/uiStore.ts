// ============================================
// Viby — UI Store (Zustand)
// Manages global UI state (modals, active views, sidebar)
// ============================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Album, Artist, LibraryView, SidebarSection, Playlist } from '../types';

interface UiState {
  // Navigation
  activeSection: SidebarSection;
  activeLibraryView: LibraryView;
  albumViewMode: 'grid' | 'list';
  selectedAlbum: Album | null;
  selectedArtist: Artist | null;
  activePlaylist: Playlist | null;
  selectedGenres: string[];
  
  // Modals & Panels
  isSearchOpen: boolean;
  isQueueOpen: boolean;
  isTheaterMode: boolean;
  isMiniPlayerOpen: boolean;
  
  // Sidebar state
  isSidebarCollapsed: boolean;

  // Actions
  setActiveSection: (section: SidebarSection) => void;
  setActiveLibraryView: (view: LibraryView) => void;
  setAlbumViewMode: (mode: 'grid' | 'list') => void;
  setSelectedAlbum: (album: Album | null) => void;
  setSelectedArtist: (artist: Artist | null) => void;
  setActivePlaylist: (playlist: Playlist | null) => void;
  setSelectedGenres: (genres: string[]) => void;
  setSearchOpen: (open: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  setTheaterMode: (enabled: boolean) => void;
  setMiniPlayerOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeSection: 'home',
      activeLibraryView: 'songs',
      albumViewMode: 'grid',
      selectedAlbum: null,
      selectedArtist: null,
      activePlaylist: null,
      selectedGenres: [],
      isSearchOpen: false,
      isQueueOpen: false,
      isTheaterMode: false,
      isMiniPlayerOpen: false,
      isSidebarCollapsed: false,

      setActiveSection: (section) => set({ activeSection: section, selectedAlbum: null, selectedArtist: null, activePlaylist: null }),
      setActiveLibraryView: (view) => set({ activeLibraryView: view, selectedAlbum: null, selectedArtist: null, activePlaylist: null }),
      setAlbumViewMode: (mode) => set({ albumViewMode: mode }),
      setSelectedAlbum: (album) => set(() => ({ 
        selectedAlbum: album, 
        selectedArtist: null, 
        activePlaylist: null,
        ...(album ? { activeSection: 'library', activeLibraryView: 'albums' } : {})
      })),
      setSelectedArtist: (artist) => set(() => ({ 
        selectedArtist: artist, 
        selectedAlbum: null, 
        activePlaylist: null,
        ...(artist ? { activeSection: 'library', activeLibraryView: 'artists' } : {})
      })),
      setActivePlaylist: (playlist) => set({ activePlaylist: playlist, selectedAlbum: null, selectedArtist: null }),
      setSelectedGenres: (genres) => set({ selectedGenres: genres }),
      setSearchOpen: (open) => set({ isSearchOpen: open }),
      setQueueOpen: (open) => set({ isQueueOpen: open }),
      setTheaterMode: (enabled) => set({ isTheaterMode: enabled }),
      setMiniPlayerOpen: (open) => set({ isMiniPlayerOpen: open }),
      toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
    }),
    {
      name: 'viby-ui',
      partialize: (state) => ({ isSidebarCollapsed: state.isSidebarCollapsed, albumViewMode: state.albumViewMode }),
    }
  )
);

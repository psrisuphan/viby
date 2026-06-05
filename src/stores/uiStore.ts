// ============================================
// Viby — UI Store (Zustand)
// Manages global UI state (modals, active views, sidebar)
// ============================================

import { create } from 'zustand';
import type { LibraryView, SidebarSection, Album, Artist } from '../types';

interface UiState {
  // Navigation
  activeSection: SidebarSection;
  activeLibraryView: LibraryView;
  selectedAlbum: Album | null;
  selectedArtist: Artist | null;
  
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
  setSelectedAlbum: (album: Album | null) => void;
  setSelectedArtist: (artist: Artist | null) => void;
  setSearchOpen: (open: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  setTheaterMode: (enabled: boolean) => void;
  setMiniPlayerOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeSection: 'home',
  activeLibraryView: 'songs',
  selectedAlbum: null,
  selectedArtist: null,
  isSearchOpen: false,
  isQueueOpen: false,
  isTheaterMode: false,
  isMiniPlayerOpen: false,
  isSidebarCollapsed: false,

  setActiveSection: (section) => set({ activeSection: section, selectedAlbum: null, selectedArtist: null }),
  setActiveLibraryView: (view) => set({ activeLibraryView: view, selectedAlbum: null, selectedArtist: null }),
  setSelectedAlbum: (album) => set({ selectedAlbum: album, selectedArtist: null }),
  setSelectedArtist: (artist) => set({ selectedArtist: artist, selectedAlbum: null }),
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  setQueueOpen: (open) => set({ isQueueOpen: open }),
  setTheaterMode: (enabled) => set({ isTheaterMode: enabled }),
  setMiniPlayerOpen: (open) => set({ isMiniPlayerOpen: open }),
  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
}));

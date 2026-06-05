// ============================================
// Viby — UI Store (Zustand)
// Manages global UI state (modals, active views, sidebar)
// ============================================

import { create } from 'zustand';
import type { LibraryView, SidebarSection } from '../types';

interface UiState {
  // Navigation
  activeSection: SidebarSection;
  activeLibraryView: LibraryView;
  
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
  setSearchOpen: (open: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  setTheaterMode: (enabled: boolean) => void;
  setMiniPlayerOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeSection: 'home',
  activeLibraryView: 'songs',
  isSearchOpen: false,
  isQueueOpen: false,
  isTheaterMode: false,
  isMiniPlayerOpen: false,
  isSidebarCollapsed: false,

  setActiveSection: (section) => set({ activeSection: section }),
  setActiveLibraryView: (view) => set({ activeLibraryView: view }),
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  setQueueOpen: (open) => set({ isQueueOpen: open }),
  setTheaterMode: (enabled) => set({ isTheaterMode: enabled }),
  setMiniPlayerOpen: (open) => set({ isMiniPlayerOpen: open }),
  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
}));

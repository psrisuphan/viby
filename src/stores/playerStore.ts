// ============================================
// Viby — Player Store (Zustand)
// Manages playback state, volume, progress
// ============================================

import { create } from 'zustand';
import type { Track, RepeatMode, AudioPathStatus, PlaybackState } from '../types';
import { useSettingsStore } from './settingsStore';

interface PlayerState {
  // Playback state
  isPlaying: boolean;
  currentTrack: Track | null;

  // Quality parameters
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioPath?: AudioPathStatus;

  // Controls mirrored from the backend playback snapshot
  volume: number;
  isMuted: boolean;
  previousVolume: number;
  shuffle: boolean;
  repeatMode: RepeatMode;

  // Actions
  setIsPlaying: (playing: boolean) => void;
  setCurrentTrack: (track: Track | null) => void;
  setPlaybackSnapshot: (snapshot: PlaybackState) => void;
}

function sameTrack(previous: Track | null, next: Track | null): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.id !== next.id) return false;

  const previousFields = previous as unknown as Record<string, unknown>;
  const nextFields = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(previousFields), ...Object.keys(nextFields)]);
  return [...keys].every((key) => Object.is(previousFields[key], nextFields[key]));
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
  isPlaying: false,
  currentTrack: null,
  volume: 1.0,
  isMuted: false,
  previousVolume: 1.0,
  shuffle: false,
  repeatMode: 'off',
  sampleRate: undefined,
  channels: undefined,
  bitsPerSample: undefined,
  audioPath: undefined,

  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTrack: (track) => {
    const previousTrack = get().currentTrack;
    set({
      currentTrack: sameTrack(previousTrack, track) ? previousTrack : track,
    });
  },
  setPlaybackSnapshot: ({
    is_playing,
    current_track,
    volume,
    is_muted,
    previous_volume,
    shuffle,
    repeat_mode,
    sample_rate,
    channels,
    bits_per_sample,
    audio_path,
  }) => {
    const previousTrack = get().currentTrack;
    const { exponentialVolume } = useSettingsStore.getState();
    const displayVol = exponentialVolume ? Math.cbrt(volume) : volume;
    const displayPreviousVolume = exponentialVolume
      ? Math.cbrt(previous_volume)
      : previous_volume;
    set({
      isPlaying: is_playing,
      currentTrack: sameTrack(previousTrack, current_track) ? previousTrack : current_track,
      volume: Math.max(0, Math.min(1, displayVol)),
      isMuted: is_muted,
      previousVolume: Math.max(0, Math.min(1, displayPreviousVolume)),
      shuffle,
      repeatMode: repeat_mode,
      sampleRate: sample_rate,
      channels,
      bitsPerSample: bits_per_sample,
      audioPath: audio_path,
    });
  },
}));

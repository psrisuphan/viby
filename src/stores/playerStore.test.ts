import { beforeEach, describe, expect, it } from 'vitest';
import { usePlayerStore } from './playerStore';
import { usePlaybackProgressStore } from './playbackProgressStore';
import { useSettingsStore } from './settingsStore';
import type { PlaybackState, Track } from '../types';

function track(title: string): Track {
  return {
    id: 'track-1',
    title,
    artist: 'Artist',
    album: 'Album',
    album_artist: 'Artist',
    genre: '',
    year: null,
    track_number: null,
    disc_number: null,
    duration_secs: 180,
    file_path: '/music/track.flac',
    file_size: 1024,
    date_added: '2026-01-01T00:00:00Z',
  };
}

describe('playerStore playback snapshots', () => {
  beforeEach(() => {
    useSettingsStore.setState({ exponentialVolume: false });
    usePlaybackProgressStore.setState({ positionSecs: 12, durationSecs: 180, generation: 0, sequence: 0 });
    usePlayerStore.setState({
      isPlaying: false,
      currentTrack: track('Old title'),
      volume: 0.5,
      isMuted: false,
      previousVolume: 0.5,
      shuffle: false,
      repeatMode: 'off',
    });
  });

  it('uses backend controls and refreshes metadata for the same current track ID', () => {
    const updatedTrack = track('Edited title');
    const snapshot: PlaybackState = {
      is_playing: true,
      current_track: updatedTrack,
      position_secs: 42,
      duration_secs: 180,
      progress_generation: 1,
      progress_sequence: 1,
      volume: 0,
      is_muted: true,
      previous_volume: 0.64,
      shuffle: true,
      repeat_mode: 'all',
    };

    usePlayerStore.getState().setPlaybackSnapshot(snapshot);

    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBe(updatedTrack);
    expect(state.volume).toBe(0);
    expect(state.isMuted).toBe(true);
    expect(state.previousVolume).toBe(0.64);
    expect(state.shuffle).toBe(true);
    expect(state.repeatMode).toBe('all');
  });

  it('refreshes metadata through setCurrentTrack without resetting same-track progress', () => {
    const updatedTrack = track('Edited title');
    usePlayerStore.getState().setCurrentTrack(updatedTrack);

    expect(usePlayerStore.getState().currentTrack).toBe(updatedTrack);
    expect(usePlaybackProgressStore.getState().positionSecs).toBe(12);
  });

  it('keeps the current track reference when a snapshot has unchanged metadata', () => {
    const previousTrack = usePlayerStore.getState().currentTrack;
    usePlayerStore.getState().setPlaybackSnapshot({
      is_playing: false,
      current_track: track('Old title'),
      position_secs: 13,
      duration_secs: 180,
      progress_generation: 1,
      progress_sequence: 2,
      volume: 0.5,
      is_muted: false,
      previous_volume: 0.5,
      shuffle: false,
      repeat_mode: 'off',
    });

    expect(usePlayerStore.getState().currentTrack).toBe(previousTrack);
  });
});

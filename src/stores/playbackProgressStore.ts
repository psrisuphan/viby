import { create } from 'zustand';
import { comparePlaybackCursor } from '../utils/playbackSyncOrder';

interface PlaybackProgressState {
  positionSecs: number;
  durationSecs: number;
  generation: number;
  sequence: number;
  seekPercent: number | null;
  setProgress: (positionSecs: number, durationSecs: number, generation: number, sequence: number) => void;
  setSeekPercent: (percent: number | null) => void;
}

export const usePlaybackProgressStore = create<PlaybackProgressState>((set) => ({
  positionSecs: 0,
  durationSecs: 0,
  generation: 0,
  sequence: 0,
  seekPercent: null,
  setProgress: (positionSecs, durationSecs, generation, sequence) => set((state) => {
    if (comparePlaybackCursor(
      { generation, sequence },
      { generation: state.generation, sequence: state.sequence },
    ) <= 0) {
      return state;
    }
    return { positionSecs, durationSecs, generation, sequence };
  }),
  setSeekPercent: (seekPercent) => set({ seekPercent }),
}));

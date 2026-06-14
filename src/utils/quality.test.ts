import { describe, expect, it } from 'vitest';
import { getPlaybackQualityInfo } from './quality';
import type { AudioPathStatus } from '../types';

function audioPath(overrides: Partial<AudioPathStatus> = {}): AudioPathStatus {
  return {
    source_sample_rate: 96000,
    source_channels: 2,
    source_bits_per_sample: 24,
    output_sample_rate: 96000,
    output_channels: 2,
    output_sample_format: 'f32',
    dsp_enabled: false,
    eq_mode: 'graphic',
    app_gain: 1,
    resampling_active: false,
    status: 'native',
    fallback_reason: null,
    ...overrides,
  };
}

describe('getPlaybackQualityInfo', () => {
  it('labels matched source and output as native when DSP is disabled', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath());

    expect(result?.badge).toBe('Native');
    expect(result?.specs).toBe('24-bit • 96 kHz • 2ch');
  });

  it('labels active equalizer processing as DSP', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath({
      dsp_enabled: true,
      eq_mode: 'parametric',
      status: 'native_dsp',
    }));

    expect(result?.badge).toBe('DSP');
  });

  it('labels output sample-rate conversion as SRC', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath({
      output_sample_rate: 48000,
      resampling_active: true,
      status: 'fallback_device',
      fallback_reason: 'native output 96000 Hz / 2 ch unavailable',
    }));

    expect(result?.badge).toBe('SRC');
    expect(result?.specs).toBe('24-bit • 96 kHz • 2ch → 48 kHz / 2ch');
  });
});

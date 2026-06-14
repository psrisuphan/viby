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
  it('labels hi-res source quality instead of backend path state', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath());

    expect(result?.badge).toBe('Hi-Res');
    expect(result?.specs).toBe('24-bit • 96 kHz • 2ch');
  });

  it('keeps lossless label visible when backend reports active DSP', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath({
      dsp_enabled: true,
      eq_mode: 'parametric',
      status: 'native_dsp',
    }));

    expect(result?.badge).toBe('Hi-Res');
  });

  it('keeps source quality label when backend reports output conversion', () => {
    const result = getPlaybackQualityInfo(96000, 24, audioPath({
      output_sample_rate: 48000,
      resampling_active: true,
      status: 'fallback_device',
      fallback_reason: 'native output 96000 Hz / 2 ch unavailable',
    }));

    expect(result?.badge).toBe('Hi-Res');
    expect(result?.specs).toBe('24-bit • 96 kHz • 2ch');
  });

  it('labels CD-quality sources as lossless', () => {
    const result = getPlaybackQualityInfo(44100, 16, audioPath({
      source_sample_rate: 44100,
      source_bits_per_sample: 16,
      output_sample_rate: 44100,
    }));

    expect(result?.badge).toBe('Lossless');
    expect(result?.specs).toBe('16-bit • 44.1 kHz • 2ch');
  });
});

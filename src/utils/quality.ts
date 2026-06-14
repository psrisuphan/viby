// ============================================
// Viby — Playback Quality Utilities
// Helper functions to format and label track quality
// ============================================

import type { AudioPathStatus } from '../types';

export interface QualityInfo {
  badge: string;
  specs: string;
  isHiRes: boolean;
  isLossless: boolean;
  isNative: boolean;
  isDsp: boolean;
  isConverted: boolean;
}

/**
 * Returns the quality label, detailed specs, and classification flags
 * based on sample rate and bits per sample.
 */
export function getPlaybackQualityInfo(
  sampleRate?: number,
  bitsPerSample?: number,
  audioPath?: AudioPathStatus
): QualityInfo | null {
  if (!sampleRate) return null;

  // Hi-Res is typically > 48 kHz (e.g., 88.2, 96, 192 kHz) or > 16-bit depth
  const isHiRes = sampleRate > 48000 || (bitsPerSample !== undefined && bitsPerSample > 16);
  // Lossless is CD quality or standard lossless (>= 44.1 kHz, e.g., 44.1 kHz, 48 kHz)
  const isLossless = sampleRate >= 44100;

  const khz = (sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1);
  const bitDepth = bitsPerSample ? `${bitsPerSample}-bit` : '';
  const sourceChannels = audioPath?.source_channels;
  const channelSpec = sourceChannels ? ` • ${sourceChannels}ch` : '';
  const outputSampleRate = audioPath?.output_sample_rate;
  const outputChannels = audioPath?.output_channels;
  const hasOutputConversion = Boolean(
    audioPath?.resampling_active ||
      (outputSampleRate && outputSampleRate !== sampleRate) ||
      (sourceChannels && outputChannels && outputChannels !== sourceChannels)
  );
  const outputSpec = hasOutputConversion && outputSampleRate
    ? ` → ${(outputSampleRate / 1000).toFixed(outputSampleRate % 1000 === 0 ? 0 : 1)} kHz${outputChannels ? ` / ${outputChannels}ch` : ''}`
    : '';
  const specs = `${bitDepth ? `${bitDepth} • ` : ''}${khz} kHz${channelSpec}${outputSpec}`;

  let badge = 'HQ';
  if (hasOutputConversion) {
    badge = 'SRC';
  } else if (audioPath?.dsp_enabled) {
    badge = 'DSP';
  } else if (audioPath && audioPath.status !== 'idle') {
    badge = 'Native';
  } else if (isHiRes) {
    badge = 'Hi-Res';
  } else if (isLossless) {
    badge = 'Lossless';
  }

  return {
    badge,
    specs,
    isHiRes,
    isLossless,
    isNative: badge === 'Native',
    isDsp: badge === 'DSP',
    isConverted: badge === 'SRC',
  };
}

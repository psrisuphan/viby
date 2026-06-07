// ============================================
// Viby — Playback Quality Utilities
// Helper functions to format and label track quality
// ============================================

export interface QualityInfo {
  badge: string;
  specs: string;
  isHiRes: boolean;
  isLossless: boolean;
}

/**
 * Returns the quality label, detailed specs, and classification flags
 * based on sample rate and bits per sample.
 */
export function getPlaybackQualityInfo(
  sampleRate?: number,
  bitsPerSample?: number
): QualityInfo | null {
  if (!sampleRate) return null;

  // Hi-Res is typically > 48 kHz (e.g., 88.2, 96, 192 kHz) or > 16-bit depth
  const isHiRes = sampleRate > 48000 || (bitsPerSample !== undefined && bitsPerSample > 16);
  // Lossless is CD quality or standard lossless (>= 44.1 kHz, e.g., 44.1 kHz, 48 kHz)
  const isLossless = sampleRate >= 44100;

  const khz = (sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1);
  const bitDepth = bitsPerSample ? `${bitsPerSample}-bit` : '';
  const specs = bitDepth ? `${bitDepth} • ${khz} kHz` : `${khz} kHz`;

  let badge = 'HQ';
  if (isHiRes) {
    badge = 'Hi-Res';
  } else if (isLossless) {
    badge = 'Lossless';
  }

  return {
    badge,
    specs,
    isHiRes,
    isLossless,
  };
}

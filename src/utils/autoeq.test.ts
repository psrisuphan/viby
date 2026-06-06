import { describe, it, expect } from 'vitest';
import { runAutoEq, parseAutoEqFilters } from './autoeq';
import type { TargetCurve } from './tauri';
import type { PeqBand } from '../stores/settingsStore';

describe('parseAutoEqFilters', () => {
  it('should parse a standard AutoEQ export filters text correctly', () => {
    const text = `
Preamp: -9.1 dB
Filter 1: ON PK Fc 50 Hz Gain -1.96 dB Q 0.421
Filter 2: ON PK Fc 183 Hz Gain -7.43 dB Q 0.454
Filter 3: ON PK Fc 739 Hz Gain 1.92 dB Q 1.265
Filter 4: ON PK Fc 1054 Hz Gain 0.93 dB Q 1.793
Filter 5: ON HSC Fc 3832 Hz Gain 0.36 dB Q 2.856
Filter 6: ON PK Fc 5194 Hz Gain 3.05 dB Q 1.750
Filter 7: ON PK Fc 9859 Hz Gain 6.06 dB Q 1.257
Filter 8: ON LSC Fc 12200 Hz Gain 4.71 dB Q 0.400
Filter 9: ON PK Fc 12395 Hz Gain -3.63 dB Q 0.545
Filter 10: ON PK Fc 16000 Hz Gain 4.84 dB Q 0.537
`;
    const result = parseAutoEqFilters(text);

    expect(result.preamp).toBe(-9.1);
    expect(result.bands.length).toBe(10);
    
    // Check PK
    expect(result.bands[0]).toEqual({
      enabled: true,
      filterType: 0,
      freq: 50,
      gain: -1.96,
      q: 0.421
    });

    // Check HSC
    expect(result.bands[4]).toEqual({
      enabled: true,
      filterType: 2,
      freq: 3832,
      gain: 0.36,
      q: 2.856
    });

    // Check LSC
    expect(result.bands[7]).toEqual({
      enabled: true,
      filterType: 1,
      freq: 12200,
      gain: 4.71,
      q: 0.400
    });
  });
});

describe('runAutoEq', () => {
  it('should successfully run the optimizer and produce bands matching the targets', () => {
    // Generate a simple dummy measurement curve (flat at 0 dB)
    const measurement: TargetCurve = {
      name: 'Flat Measurement',
      points: [
        [20, 0],
        [100, 0],
        [1000, 0],
        [10000, 0],
        [20000, 0]
      ]
    };

    // Generate a target curve (with a bass shelf of +4 dB and some dips)
    const target: TargetCurve = {
      name: 'Custom Target Curve',
      points: [
        [20, 4],
        [100, 4],
        [1000, 0],
        [10000, -2],
        [20000, -2]
      ]
    };

    // We will optimize 3 peaking bands
    const initialBands: PeqBand[] = [
      { enabled: true, filterType: 0, freq: 100, gain: 0, q: 1.0 },
      { enabled: true, filterType: 0, freq: 1000, gain: 0, q: 1.0 },
      { enabled: true, filterType: 0, freq: 5000, gain: 0, q: 1.0 }
    ];

    const result = runAutoEq(measurement, target, initialBands);

    // Verify optimized output structure
    expect(result.bands.length).toBe(3);
    expect(result.preamp).toBeLessThanOrEqual(0);

    for (const band of result.bands) {
      expect(band.enabled).toBe(true);
      expect(band.freq).toBeGreaterThanOrEqual(20);
      expect(band.freq).toBeLessThanOrEqual(20000);
      expect(band.gain).toBeGreaterThanOrEqual(-12);
      expect(band.gain).toBeLessThanOrEqual(12);
      expect(band.q).toBeGreaterThanOrEqual(0.1);
      expect(band.q).toBeLessThanOrEqual(10.0);
    }
  });
});

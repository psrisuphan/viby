import { describe, it, expect } from 'vitest';
import { parseAutoEqFilters } from './autoeq';

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

import { describe, expect, it } from 'vitest';
import { getStoredTheme } from './themeStore';

function storageWith(value: string | null) {
  return {
    getItem: () => value,
  };
}

describe('getStoredTheme', () => {
  it('reads the current zustand persisted theme shape', () => {
    const storage = storageWith(JSON.stringify({ state: { theme: 'dracula' }, version: 0 }));

    expect(getStoredTheme(storage)).toBe('dracula');
  });

  it('reads the legacy plain theme shape', () => {
    const storage = storageWith(JSON.stringify({ theme: 'kanagawa' }));

    expect(getStoredTheme(storage)).toBe('kanagawa');
  });

  it('falls back to the default theme for invalid theme ids', () => {
    const storage = storageWith(JSON.stringify({ state: { theme: 'unknown-theme' }, version: 0 }));

    expect(getStoredTheme(storage)).toBe('viby');
  });

  it('falls back to the default theme for malformed storage', () => {
    expect(getStoredTheme(storageWith('{'))).toBe('viby');
    expect(getStoredTheme(storageWith(null))).toBe('viby');
  });
});

import { describe, expect, it } from 'vitest';
import { getStoredTheme, getThemeAccent, getThemeColorScheme } from './themeStore';

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

describe('getThemeColorScheme', () => {
  it('returns the native color scheme for each theme group', () => {
    expect(getThemeColorScheme('github-light')).toBe('light');
    expect(getThemeColorScheme('viby')).toBe('dark');
  });
});

describe('getThemeAccent', () => {
  it('returns the configured preview accent for a theme', () => {
    expect(getThemeAccent('dracula')).toBe('#bd93f9');
  });

  it('falls back to the default theme accent for unknown theme ids', () => {
    const unknownTheme = 'unknown-theme' as Parameters<typeof getThemeAccent>[0];

    expect(getThemeAccent(unknownTheme)).toBe('hsl(125,75%,70%)');
  });
});

// @ts-expect-error Node types are only needed by Vitest, not the browser build.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../stores/themeStore';

const themesCss = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');

const textTokens = [
  'text-primary',
  'text-secondary',
  'text-tertiary',
  'accent-text',
  'danger',
  'color-info',
  'color-success',
  'color-warning',
  'color-link',
] as const;

function token(block: string, name: string) {
  const value = block.match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function luminance(hex: string) {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255);
  return channels.reduce((sum, value, index) => {
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(a: string, b: string) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('light theme contrast', () => {
  for (const theme of THEMES.filter(({ group }) => group === 'light')) {
    it(`${theme.name} meets WCAG contrast targets`, () => {
      const start = themesCss.indexOf(`[data-theme="${theme.id}"]`);
      expect(start, `Missing CSS for ${theme.id}`).toBeGreaterThanOrEqual(0);
      const block = themesCss.slice(start, themesCss.indexOf('}', start));

      const background = token(block, 'bg-primary');
      for (const name of textTokens) {
        expect(contrast(token(block, name), background), `${theme.name} --${name}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(token(block, 'accent'), background), `${theme.name} --accent`).toBeGreaterThanOrEqual(3);
      expect(
        contrast(token(block, 'text-on-accent'), token(block, 'accent')),
        `${theme.name} --text-on-accent`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

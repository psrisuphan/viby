export type Platform = 'macos' | 'windows' | 'linux';

export function getPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macos';
  return 'linux';
}

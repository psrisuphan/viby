import type { Track } from '../types';

export function filterTracks(tracks: Track[], query: string): Track[] {
  const q = query.trim();
  if (!q) return tracks;
  const tokens = q.toLowerCase().split(/\s+/);
  return tracks.filter(track => {
    const haystack = [
      track.title,
      track.artist,
      track.album,
      track.album_artist,
      track.year?.toString() ?? '',
      track.file_path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '',
    ].join('\x00').toLowerCase();
    return tokens.every(t => haystack.includes(t));
  });
}

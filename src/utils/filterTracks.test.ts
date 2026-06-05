import { describe, it, expect } from 'vitest';
import { filterTracks } from './filterTracks';
import type { Track } from '../types';

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'test-id',
    title: 'Test Title',
    artist: 'Test Artist',
    album: 'Test Album',
    album_artist: 'Test Artist',
    genre: 'Rock',
    year: 2020,
    track_number: 1,
    disc_number: 1,
    duration_secs: 180,
    file_path: '/music/test.mp3',
    file_size: 1024,
    date_added: '2024-01-01',
    ...overrides,
  };
}

const tracks: Track[] = [
  makeTrack({ id: '1', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', year: 1975 }),
  makeTrack({ id: '2', title: 'Hotel California', artist: 'Eagles', album: 'Hotel California', genre: 'Rock', year: 1977 }),
  makeTrack({ id: '3', title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', genre: 'Rock', year: 1971 }),
  makeTrack({ id: '4', title: 'Imagine', artist: 'John Lennon', album: 'Imagine', genre: 'Pop', year: 1971, file_path: '/music/imagine.flac' }),
];

describe('filterTracks', () => {
  it('returns all tracks for empty query', () => {
    expect(filterTracks(tracks, '').length).toBe(4);
    expect(filterTracks(tracks, '   ').length).toBe(4);
  });

  it('matches by title (case-insensitive)', () => {
    const result = filterTracks(tracks, 'bohemian');
    expect(result.map(t => t.id)).toEqual(['1']);
  });

  it('matches by artist', () => {
    const result = filterTracks(tracks, 'eagles');
    expect(result.map(t => t.id)).toEqual(['2']);
  });

  it('matches by album', () => {
    const result = filterTracks(tracks, 'Led Zeppelin IV');
    expect(result.map(t => t.id)).toEqual(['3']);
  });

  it('does not match by genre (genre has dedicated filter UI)', () => {
    // "Pop" is Imagine's genre — text search should NOT match on genre field.
    // Genre filtering is handled separately by the GenreFilter dropdown.
    const result = filterTracks(tracks, 'pop');
    expect(result.length).toBe(0);
  });

  it('matches by year', () => {
    const result = filterTracks(tracks, '1971');
    expect(result.map(t => t.id).sort()).toEqual(['3', '4']);
  });

  it('matches by filename (without extension)', () => {
    const result = filterTracks(tracks, 'imagine');
    expect(result.map(t => t.id)).toContain('4');
  });

  it('multi-token: all tokens must match', () => {
    // "queen 1975" should match Bohemian Rhapsody only
    const result = filterTracks(tracks, 'queen 1975');
    expect(result.map(t => t.id)).toEqual(['1']);
  });

  it('multi-token: returns empty if one token has no match', () => {
    const result = filterTracks(tracks, 'queen 1977');
    expect(result.length).toBe(0);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterTracks(tracks, 'xyznonexistent').length).toBe(0);
  });
});

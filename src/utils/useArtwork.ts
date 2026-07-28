import { useState, useEffect } from 'react';
import { getPlatform } from './platform';
import { getTrackArtwork } from './tauri';
import { createTaskQueue } from './taskQueue';

// Cache sets for fast lookup without IPC
const noArtworkSet = new Set<string>();
const hasArtworkSet = new Set<string>();

// On Windows we use IPC + data URIs, so we need to cache the actual data URL
// to avoid repeated IPC calls.
const dataUrlCache = new Map<string, string>();
const MAX_DATA_URL_CACHE_ENTRIES = 64;
const MAX_HAS_ARTWORK_CACHE_ENTRIES = 512;
const MAX_NO_ARTWORK_CACHE_ENTRIES = 512;
const IS_WINDOWS = getPlatform() === 'windows';
const runArtworkTask = createTaskQueue(4);
const artworkRequests = new Map<string, Promise<string | null>>();
let artworkCacheGeneration = 0;

function rememberNoArtwork(cacheKey: string) {
  noArtworkSet.delete(cacheKey);
  noArtworkSet.add(cacheKey);
  while (noArtworkSet.size > MAX_NO_ARTWORK_CACHE_ENTRIES) {
    const oldest = noArtworkSet.values().next().value;
    if (!oldest) break;
    noArtworkSet.delete(oldest);
  }
}

function rememberArtwork(cacheKey: string, dataUrl?: string) {
  noArtworkSet.delete(cacheKey);
  hasArtworkSet.delete(cacheKey);
  hasArtworkSet.add(cacheKey);
  if (IS_WINDOWS && dataUrl !== undefined) {
    dataUrlCache.delete(cacheKey);
    dataUrlCache.set(cacheKey, dataUrl);
  }
  while (dataUrlCache.size > MAX_DATA_URL_CACHE_ENTRIES) {
    const oldest = dataUrlCache.keys().next().value;
    if (!oldest) break;
    dataUrlCache.delete(oldest);
    hasArtworkSet.delete(oldest);
  }
  while (hasArtworkSet.size > MAX_HAS_ARTWORK_CACHE_ENTRIES) {
    const oldest = hasArtworkSet.values().next().value;
    if (!oldest) break;
    hasArtworkSet.delete(oldest);
    dataUrlCache.delete(oldest);
  }
}

function getCachedDataUrl(cacheKey: string) {
  const dataUrl = dataUrlCache.get(cacheKey);
  if (!dataUrl) return null;
  hasArtworkSet.delete(cacheKey);
  hasArtworkSet.add(cacheKey);
  dataUrlCache.delete(cacheKey);
  dataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

export function clearArtworkCache() {
  artworkCacheGeneration += 1;
  noArtworkSet.clear();
  hasArtworkSet.clear();
  dataUrlCache.clear();
}

export function getArtworkCacheSize() {
  return hasArtworkSet.size + noArtworkSet.size;
}

export type ArtworkSize = 128 | 384 | 768;

export function artworkCacheKey(artworkKey: string, size: ArtworkSize) {
  return `${artworkKey}@${size}`;
}

function getArtworkUrl(trackId: string, size: ArtworkSize): string {
  if (!('__TAURI_INTERNALS__' in window)) {
    if (trackId === 'track-1') {
      return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%238a2be2"/><stop offset="100%" stop-color="%234a00e0"/></linearGradient></defs><rect width="300" height="300" fill="url(%23g)"/></svg>';
    }
    if (trackId === 'track-2') {
      return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23f12711"/><stop offset="100%" stop-color="%23f5af19"/></linearGradient></defs><rect width="300" height="300" fill="url(%23g)"/></svg>';
    }
    if (trackId === 'track-3') {
      return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2311998e"/><stop offset="100%" stop-color="%2338ef7d"/></linearGradient></defs><rect width="300" height="300" fill="url(%23g)"/></svg>';
    }
    return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%238a2be2"/><stop offset="100%" stop-color="%234a00e0"/></linearGradient></defs><rect width="300" height="300" fill="url(%23g)"/></svg>';
  }
  if (IS_WINDOWS) {
    return `http://viby-artwork.localhost/${trackId}?size=${size}`;
  }
  return `viby-artwork://localhost/${trackId}?size=${size}`;
}

function requestArtwork(trackId: string, cacheKey: string, size: ArtworkSize) {
  const existing = artworkRequests.get(cacheKey);
  if (existing) return existing;

  const generation = artworkCacheGeneration;
  const request = runArtworkTask(async () => {
    if (IS_WINDOWS) {
      const payload = await getTrackArtwork(trackId, size);
      return payload ? `data:${payload.mime_type};base64,${payload.data}` : null;
    }

    const url = getArtworkUrl(trackId, size);
    return new Promise<string | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(url);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  })
    .then((url) => {
      if (generation === artworkCacheGeneration) {
        if (url) rememberArtwork(cacheKey, IS_WINDOWS ? url : undefined);
        else rememberNoArtwork(cacheKey);
      }
      return url;
    })
    .catch(() => {
      if (generation === artworkCacheGeneration) rememberNoArtwork(cacheKey);
      return null;
    })
    .finally(() => artworkRequests.delete(cacheKey));

  artworkRequests.set(cacheKey, request);
  return request;
}

// albumKey deduplicates the cache across tracks on the same album.
// Pass "${album}||${album_artist}" when available; omit to fall back to track_id keying.
interface UseArtworkOptions {
  paused?: boolean;
  delayMs?: number;
  size?: ArtworkSize;
}

export function useArtwork(
  trackId: string | null,
  albumKey?: string,
  options: UseArtworkOptions = {},
) {
  const size = options.size ?? 384;
  const artworkKey = (trackId && albumKey) ? albumKey : (trackId ?? null);
  const cacheKey = artworkKey ? artworkCacheKey(artworkKey, size) : null;
  const paused = options.paused ?? false;
  const delayMs = options.delayMs ?? 80;

  const [artworkUrl, setArtworkUrl] = useState<string | null>(() => {
    if (!trackId || !cacheKey) return null;
    if (noArtworkSet.has(cacheKey)) return null;
    if (hasArtworkSet.has(cacheKey)) {
      // On Windows, return cached data URL; on other platforms, return protocol URL
      if (IS_WINDOWS) {
        return getCachedDataUrl(cacheKey);
      }
      rememberArtwork(cacheKey);
      return getArtworkUrl(trackId, size);
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);

	  useEffect(() => {
	    if (!trackId || !cacheKey) {
	      setArtworkUrl(null);
	      setIsLoading(false);
	      return;
	    }

    // Cache hit - positive
    if (hasArtworkSet.has(cacheKey)) {
      if (IS_WINDOWS) {
        const cached = getCachedDataUrl(cacheKey);
        if (cached) {
          setArtworkUrl(cached);
          setIsLoading(false);
          return;
        }
        hasArtworkSet.delete(cacheKey);
	      } else {
          rememberArtwork(cacheKey);
	        setArtworkUrl(getArtworkUrl(trackId, size));
          setIsLoading(false);
          return;
	      }
	    }

    // Cache hit - negative (known not to have artwork)
	    if (noArtworkSet.has(cacheKey)) {
	      setArtworkUrl(null);
	      setIsLoading(false);
	      return;
	    }

	    setArtworkUrl(null);
	    if (paused) {
	      setIsLoading(false);
	      return;
	    }

    let isMounted = true;

    // Delay the fetch so items that scroll through quickly never load.
    const timer = setTimeout(() => {
      if (!isMounted) return;

	      setIsLoading(true);

      requestArtwork(trackId, cacheKey, size).then((url) => {
        if (!isMounted) return;
        setArtworkUrl(url);
        setIsLoading(false);
      });
    }, delayMs);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
	  }, [trackId, cacheKey, paused, delayMs, size]);

  return { artworkUrl, isLoading };
}

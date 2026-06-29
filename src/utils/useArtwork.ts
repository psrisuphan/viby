import { useState, useEffect } from 'react';
import { getPlatform } from './platform';
import { getTrackArtwork } from './tauri';

// Cache sets for fast lookup without IPC
const noArtworkSet = new Set<string>();
const hasArtworkSet = new Set<string>();

// On Windows we use IPC + data URIs, so we need to cache the actual data URL
// to avoid repeated IPC calls.
const dataUrlCache = new Map<string, string>();

export function clearArtworkCache() {
  noArtworkSet.clear();
  hasArtworkSet.clear();
  dataUrlCache.clear();
}

export function getArtworkCacheSize() {
  return hasArtworkSet.size + noArtworkSet.size;
}


const IS_WINDOWS = getPlatform() === 'windows';

function getArtworkUrl(trackId: string): string {
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
    return `http://viby-artwork.localhost/${trackId}`;
  }
  return `viby-artwork://localhost/${trackId}`;
}

// albumKey deduplicates the cache across tracks on the same album.
// Pass "${album}||${album_artist}" when available; omit to fall back to track_id keying.
interface UseArtworkOptions {
  paused?: boolean;
  delayMs?: number;
}

export function useArtwork(
  trackId: string | null,
  albumKey?: string,
  options: UseArtworkOptions = {},
) {
  const cacheKey = (trackId && albumKey) ? albumKey : (trackId ?? null);
  const paused = options.paused ?? false;
  const delayMs = options.delayMs ?? 80;

  const [artworkUrl, setArtworkUrl] = useState<string | null>(() => {
    if (!trackId || !cacheKey) return null;
    if (noArtworkSet.has(cacheKey)) return null;
    if (hasArtworkSet.has(cacheKey)) {
      // On Windows, return cached data URL; on other platforms, return protocol URL
      if (IS_WINDOWS) {
        return dataUrlCache.get(cacheKey) ?? null;
      }
      return getArtworkUrl(trackId);
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
        setArtworkUrl(dataUrlCache.get(cacheKey) ?? null);
	      } else {
	        setArtworkUrl(getArtworkUrl(trackId));
	      }
	      setIsLoading(false);
	      return;
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

      if (IS_WINDOWS) {
        // On Windows, use IPC command to get artwork as base64.
        // Custom protocol URLs can be unreliable on Windows due to
        // WebView2 origin/scheme handling differences.
        getTrackArtwork(trackId)
          .then((payload) => {
            if (!isMounted) return;
            if (payload) {
              const dataUrl = `data:${payload.mime_type};base64,${payload.data}`;
              hasArtworkSet.add(cacheKey);
              dataUrlCache.set(cacheKey, dataUrl);
              setArtworkUrl(dataUrl);
            } else {
              noArtworkSet.add(cacheKey);
              setArtworkUrl(null);
            }
	            setIsLoading(false);
	          })
	          .catch(() => {
	            if (!isMounted) return;
	            noArtworkSet.add(cacheKey);
	            setArtworkUrl(null);
	            setIsLoading(false);
	          });
      } else {
        // On macOS/Linux, use the custom protocol URL directly via Image probe
        const url = getArtworkUrl(trackId);
        const img = new Image();
        img.src = url;

	        img.onload = () => {
	          if (!isMounted) return;
	          hasArtworkSet.add(cacheKey);
	          setArtworkUrl(url);
	          setIsLoading(false);
	        };

	        img.onerror = () => {
	          if (!isMounted) return;
	          noArtworkSet.add(cacheKey);
	          setArtworkUrl(null);
	          setIsLoading(false);
	        };
      }
    }, delayMs);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
	  }, [trackId, cacheKey, paused, delayMs]);

  return { artworkUrl, isLoading };
}

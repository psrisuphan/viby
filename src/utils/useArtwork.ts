import { useState, useEffect } from 'react';

// Cache sets for fast lookup without IPC
const noArtworkSet = new Set<string>();
const hasArtworkSet = new Set<string>();

export function clearArtworkCache() {
  noArtworkSet.clear();
  hasArtworkSet.clear();
}

export function getArtworkCacheSize() {
  return hasArtworkSet.size + noArtworkSet.size;
}

// albumKey deduplicates the cache across tracks on the same album.
// Pass "${album}||${album_artist}" when available; omit to fall back to track_id keying.
export function useArtwork(trackId: string | null, albumKey?: string) {
  const cacheKey = (trackId && albumKey) ? albumKey : (trackId ?? null);

  const [artworkUrl, setArtworkUrl] = useState<string | null>(() => {
    if (!trackId || !cacheKey) return null;
    if (noArtworkSet.has(cacheKey)) return null;
    if (hasArtworkSet.has(cacheKey)) return `viby-artwork://localhost/${trackId}`;
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
      setArtworkUrl(`viby-artwork://localhost/${trackId}`);
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
    let isMounted = true;

    // Delay the fetch so items that scroll through quickly (< 80ms) never load
    const timer = setTimeout(() => {
      if (!isMounted) return;

      setIsLoading(true);
      const url = `viby-artwork://localhost/${trackId}`;
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
    }, 80);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [trackId, cacheKey]);

  return { artworkUrl, isLoading };
}

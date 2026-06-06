import { useState, useEffect } from 'react';
import { getTrackArtwork, type ArtworkPayload } from './tauri';

// LRU cache capped at MAX_CACHE entries — oldest entry evicted when full.
// JS Map preserves insertion order, so keys().next() is always the oldest.
const MAX_CACHE = 500;
const artworkCache = new Map<string, string | null>();

export function clearArtworkCache() {
  artworkCache.clear();
  pendingRequests.clear();
}

export function getArtworkCacheSize() {
  return artworkCache.size;
}

function setCached(id: string, url: string | null) {
  if (artworkCache.size >= MAX_CACHE) {
    const oldest = artworkCache.keys().next().value;
    if (oldest !== undefined) artworkCache.delete(oldest);
  }
  artworkCache.set(id, url);
}

// Deduplicates concurrent requests for the same track ID
const pendingRequests = new Map<string, Promise<ArtworkPayload | null>>();

// albumKey deduplicates the frontend cache across tracks on the same album.
// Pass "${album}||${album_artist}" when the caller has that info; omit to fall
// back to track_id keying (e.g. when only a track ID is available).
export function useArtwork(trackId: string | null, albumKey?: string) {
  const cacheKey = (trackId && albumKey) ? albumKey : (trackId ?? null);

  const [artworkUrl, setArtworkUrl] = useState<string | null>(() =>
    cacheKey && artworkCache.has(cacheKey) ? (artworkCache.get(cacheKey) ?? null) : null
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!trackId || !cacheKey) {
      setArtworkUrl(null);
      return;
    }

    // If it's already cached, apply immediately and bail
    if (artworkCache.has(cacheKey)) {
      setArtworkUrl(artworkCache.get(cacheKey) ?? null);
      return;
    }

    setArtworkUrl(null);

    let isMounted = true;

    // Delay the IPC fetch so items that scroll through quickly (< 80ms) never
    // fire a request — prevents a flood of concurrent calls during fast scroll.
    const timer = setTimeout(async () => {
      if (!isMounted) return;

      // Re-check cache inside the timer in case another instance already fetched it
      if (artworkCache.has(cacheKey)) {
        setArtworkUrl(artworkCache.get(cacheKey) ?? null);
        return;
      }

      setIsLoading(true);

      try {
        let payload: ArtworkPayload | null = null;

        // Deduplicate concurrent requests by cacheKey
        if (pendingRequests.has(cacheKey)) {
          payload = await pendingRequests.get(cacheKey)!;
        } else {
          const req = getTrackArtwork(trackId);
          pendingRequests.set(cacheKey, req);
          payload = await req;
          pendingRequests.delete(cacheKey);
        }

        // Cache the result, using the correct MIME type from the backend
        const objectUrl = payload ? `data:${payload.mime_type};base64,${payload.data}` : null;
        setCached(cacheKey, objectUrl);

        if (isMounted) {
          setArtworkUrl(objectUrl);
        }
      } catch (e) {
        console.error("Failed to load artwork for", trackId, e);
        if (isMounted) setArtworkUrl(null);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }, 80);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [trackId, cacheKey]);

  return { artworkUrl, isLoading };
}

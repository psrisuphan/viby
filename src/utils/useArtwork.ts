import { useState, useEffect } from 'react';
import { getTrackArtwork, type ArtworkPayload } from './tauri';

// LRU cache capped at MAX_CACHE entries — oldest entry evicted when full.
// JS Map preserves insertion order, so keys().next() is always the oldest.
const MAX_CACHE = 200;
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

export function useArtwork(trackId: string | null) {
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!trackId) {
      setArtworkUrl(null);
      return;
    }

    // If it's already cached, return immediately
    if (artworkCache.has(trackId)) {
      setArtworkUrl(artworkCache.get(trackId) || null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    const fetchArtwork = async () => {
      try {
        let payload: ArtworkPayload | null = null;

        // Check if there's an ongoing request for this trackId
        if (pendingRequests.has(trackId)) {
          payload = await pendingRequests.get(trackId)!;
        } else {
          // Fire new request and store the promise
          const req = getTrackArtwork(trackId);
          pendingRequests.set(trackId, req);
          payload = await req;
          pendingRequests.delete(trackId);
        }

        // Cache the result, using the correct MIME type from the backend
        const objectUrl = payload ? `data:${payload.mime_type};base64,${payload.data}` : null;
        setCached(trackId, objectUrl);

        if (isMounted) {
          setArtworkUrl(objectUrl);
        }
      } catch (e) {
        console.error("Failed to load artwork for", trackId, e);
        if (isMounted) setArtworkUrl(null);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    fetchArtwork();

    return () => {
      isMounted = false;
    };
  }, [trackId]);

  return { artworkUrl, isLoading };
}

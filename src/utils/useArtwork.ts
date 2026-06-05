import { useState, useEffect } from 'react';
import { getTrackArtwork, type ArtworkPayload } from './tauri';

// Global cache to prevent re-fetching the same artwork across component mounts
const artworkCache = new Map<string, string | null>();
// Keep track of pending promises so multiple components requesting the same ID don't trigger duplicate backend calls
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
        artworkCache.set(trackId, objectUrl);

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

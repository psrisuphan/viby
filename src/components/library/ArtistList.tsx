import { useMemo, useRef, useState, useLayoutEffect, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Mic2 } from 'lucide-react';
import type { Artist } from '../../types';
import { useUiStore } from '../../stores/uiStore';
import { useLibraryStore } from '../../stores/libraryStore';
import { useArtwork } from '../../utils/useArtwork';
import './ArtistList.css';

interface ArtistListProps {
  artists: Artist[];
  scrollRef?: RefObject<HTMLElement | null>;
}

function ArtistRow({
  artist,
  artworkTrackId,
  onClick,
}: {
  artist: Artist;
  artworkTrackId: string | null;
  onClick: () => void;
}) {
  const { artworkUrl } = useArtwork(artworkTrackId, undefined, { size: 128 });

  return (
    <div className="artist-row" onClick={onClick}>
      <div className="artist-avatar">
        {artworkUrl ? (
          <img src={artworkUrl} alt={artist.name} className="artist-list-img" />
        ) : (
          <Mic2 size={24} className="text-tertiary" />
        )}
      </div>
      <div className="artist-info">
        <h3 className="artist-name">{artist.name}</h3>
        <p className="artist-stats">
          {artist.album_count} {artist.album_count === 1 ? 'album' : 'albums'} • {artist.track_count} {artist.track_count === 1 ? 'song' : 'songs'}
        </p>
      </div>
    </div>
  );
}

// Row height: 56px avatar + 12px padding top + 12px padding bottom + 1px border = 81px
const ITEM_HEIGHT = 81;

export default function ArtistList({ artists, scrollRef }: ArtistListProps) {
  const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
  const albums = useLibraryStore((s) => s.albums);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const artistArtworkByName = useMemo(() => {
    const best = new Map<string, { year: number; artworkTrackId: string }>();
    for (const album of albums) {
      if (!album.artwork_track_id) continue;
      const year = album.year ?? 0;
      const current = best.get(album.artist);
      if (!current || year > current.year) {
        best.set(album.artist, {
          year,
          artworkTrackId: album.artwork_track_id,
        });
      }
    }
    return best;
  }, [albums]);

  useLayoutEffect(() => {
    if (!scrollRef?.current || !listRef.current) return;
    const update = () => {
      const listTop = listRef.current!.getBoundingClientRect().top;
      const scrollTop = scrollRef!.current!.getBoundingClientRect().top;
      setScrollMargin(listTop - scrollTop + scrollRef!.current!.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [scrollRef]);

  const rowVirtualizer = useVirtualizer({
    count: artists.length,
    getScrollElement: () => scrollRef?.current ?? listRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
    scrollMargin: scrollRef ? scrollMargin : 0,
  });

  if (artists.length === 0) {
    return (
      <div className="empty-state">
        <p>No artists found in your library.</p>
      </div>
    );
  }

  return (
    <div
      className="artist-list"
      ref={listRef}
      style={{ position: 'relative', height: `${rowVirtualizer.getTotalSize()}px` }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const artist = artists[virtualRow.index];
        return (
          <div
            key={`${artist.name}-${virtualRow.index}`}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start - (scrollRef ? scrollMargin : 0)}px)`,
            }}
          >
            <ArtistRow
              artist={artist}
              artworkTrackId={artistArtworkByName.get(artist.name)?.artworkTrackId ?? null}
              onClick={() => setSelectedArtist(artist)}
            />
          </div>
        );
      })}
    </div>
  );
}

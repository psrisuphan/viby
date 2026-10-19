import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
  Play,
  Music,
  Disc,
  Mic2,
  ListPlus,
  Info,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { runActionWithFeedback } from "../../utils/actionFeedback";
import {
  addToQueue,
  addToQueueNext,
  addTracksToQueue,
  addTracksToQueueNext,
  getAlbumTracks,
  playTrack,
  playTracks as playTracksAtomic,
  searchLibrary,
} from "../../utils/tauri";
import { useArtwork } from "../../utils/useArtwork";
import type { SearchResults, Album, Artist, Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import AddToPlaylistModal from "../playlist/AddToPlaylistModal";
import TrackMetadataModal from "../ui/TrackMetadataModal";
import AlbumInfoModal from "../ui/AlbumInfoModal";
import AccessibleDialog from "../ui/AccessibleDialog";
import { findTrackAlbum } from "../../utils/findTrackAlbum";
import "./SearchModal.css";

function SearchTrackItem({
  track,
  onPlay,
  onContextMenu,
}: {
  track: Track;
  onPlay: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, track: Track) => void;
}) {
  const { artworkUrl } = useArtwork(
    track.id,
    `${track.album}||${track.album_artist}`,
    { size: 128 },
  );

  return (
    <div
      className="search-item search-track-item"
      tabIndex={-1}
      onDoubleClick={() => onPlay(track.id)}
      onContextMenu={(e) => onContextMenu(e, track)}
    >
      <div className="search-item-artwork-container">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="search-item-artwork" />
        ) : (
          <div className="search-item-artwork-placeholder">
            <Music size={16} />
          </div>
        )}
        <button className="search-item-play" onClick={() => onPlay(track.id)}>
          <Play size={14} fill="currentColor" style={{ marginLeft: "1.5px" }} />
        </button>
      </div>
      <div className="search-item-info">
        <div className="search-item-title truncate">{track.title}</div>
        <div className="search-item-subtitle truncate">
          {track.artist} • {track.album}
        </div>
      </div>
    </div>
  );
}

function SearchAlbumItem({
  album,
  onClick,
  onContextMenu,
}: {
  album: Album;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent, album: Album) => void;
}) {
  const { artworkUrl } = useArtwork(
    album.artwork_track_id,
    `${album.name}||${album.artist}`,
    { size: 128 },
  );

  return (
    <button
      type="button"
      className="search-item search-album-item"
      aria-label={`Open album ${album.name}`}
      onClick={onClick}
      onContextMenu={(e) => onContextMenu(e, album)}
    >
      <span className="search-item-artwork-container">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="search-item-artwork" />
        ) : (
          <span className="search-item-artwork-placeholder">
            <Disc size={16} />
          </span>
        )}
      </span>
      <span className="search-item-info">
        <span className="search-item-title truncate">{album.name}</span>
        <span className="search-item-subtitle truncate">
          {album.artist} • {album.track_count} tracks
        </span>
      </span>
    </button>
  );
}

function SearchArtistItem({
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
    <button
      type="button"
      className="search-item search-artist-item"
      aria-label={`Open artist ${artist.name}`}
      onClick={onClick}
    >
      <span className="search-item-artwork-container search-item-artwork-container--round">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" className="search-item-artwork" />
        ) : (
          <span className="search-item-artwork-placeholder">
            <Mic2 size={16} />
          </span>
        )}
      </span>
      <span className="search-item-info">
        <span className="search-item-title truncate">{artist.name}</span>
        <span className="search-item-subtitle truncate">
          {artist.album_count} albums • {artist.track_count} tracks
        </span>
      </span>
    </button>
  );
}

export default function SearchModal() {
  const setSearchOpen = useUiStore((s) => s.setSearchOpen);
  const setActiveSection = useUiStore((s) => s.setActiveSection);
  const setActiveLibraryView = useUiStore((s) => s.setActiveLibraryView);
  const setSelectedAlbum = useUiStore((s) => s.setSelectedAlbum);
  const setSelectedArtist = useUiStore((s) => s.setSelectedArtist);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const albums = useLibraryStore((s) => s.albums);
  const artistArtworkIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const album of albums) {
      if (album.artwork_track_id && !ids.has(album.artist)) {
        ids.set(album.artist, album.artwork_track_id);
      }
    }
    return ids;
  }, [albums]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "track" | "album";
    item: any;
    returnFocusTo: HTMLElement;
  } | null>(null);
  const [selectedTrackForPlaylist, setSelectedTrackForPlaylist] =
    useState<Track | null>(null);
  const [metadataTrack, setMetadataTrack] = useState<Track | null>(null);
  const [infoAlbum, setInfoAlbum] = useState<Album | null>(null);

  const handleTrackContextMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    const returnFocusTo = e.currentTarget as HTMLElement;
    returnFocusTo.focus({ preventScroll: true });
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: "track",
      item: track,
      returnFocusTo,
    });
  };

  const handleAlbumContextMenu = (e: React.MouseEvent, album: Album) => {
    e.preventDefault();
    const returnFocusTo = e.currentTarget as HTMLElement;
    returnFocusTo.focus({ preventScroll: true });
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: "album",
      item: album,
      returnFocusTo,
    });
  };

  const getTrackContextMenuItems = (track: Track): ContextMenuItem[] => [
    {
      label: "Play",
      icon: <Play size={14} />,
      onClick: () => {
        void handlePlaySong(track.id);
        setContextMenu(null);
      },
    },
    {
      label: "Add to Queue",
      icon: <ListPlus size={14} />,
      onClick: () => {
        void runActionWithFeedback(() => addToQueue(track.id), {
          failureMessage: `Couldn't add "${track.title}" to the queue.`,
          successMessage: `Added "${track.title}" to queue`,
        });
        setContextMenu(null);
      },
    },
    {
      label: "Play Next",
      icon: <ListPlus size={14} />,
      onClick: () => {
        void runActionWithFeedback(() => addToQueueNext(track.id), {
          failureMessage: `Couldn't play "${track.title}" next.`,
          successMessage: `Queued "${track.title}" to play next`,
        });
        setContextMenu(null);
      },
    },
    {
      label: "Add to Playlist...",
      icon: <ListPlus size={14} />,
      onClick: () => {
        setSelectedTrackForPlaylist(track);
        setContextMenu(null);
      },
    },
    {
      label: "Go to Album",
      icon: <Disc size={14} />,
      onClick: () => {
        const album = findTrackAlbum(albums, track);
        if (album) handleAlbumClick(album);
        setContextMenu(null);
      },
    },
    {
      label: "Song Info",
      icon: <Info size={14} />,
      onClick: () => {
        setMetadataTrack(track);
        setContextMenu(null);
      },
    },
  ];

  const getAlbumContextMenuItems = (album: Album): ContextMenuItem[] => [
    {
      label: "Play",
      icon: <Play size={14} />,
      onClick: () => {
        void runActionWithFeedback(
          async () => {
            const tracks = await getAlbumTracks(album.name, album.artist);
            if (tracks.length > 0) {
              await playTracksAtomic(
                tracks.map(({ id }) => id),
                0,
                false,
              );
            }
            setContextMenu(null);
          },
          { failureMessage: `Couldn't play album "${album.name}".` },
        );
      },
    },
    {
      label: "Add to Queue",
      icon: <ListPlus size={14} />,
      onClick: () => {
        void runActionWithFeedback(
          async () => {
            const tracks = await getAlbumTracks(album.name, album.artist);
            if (tracks.length > 0)
              await addTracksToQueue(tracks.map(({ id }) => id));
            setContextMenu(null);
            return tracks.length;
          },
          {
            failureMessage: `Couldn't add album "${album.name}" to the queue.`,
            successMessage: (count) =>
              count > 0 ? `Added album "${album.name}" to queue` : "",
          },
        );
      },
    },
    {
      label: "Play Next",
      icon: <ListPlus size={14} />,
      onClick: () => {
        void runActionWithFeedback(
          async () => {
            const tracks = await getAlbumTracks(album.name, album.artist);
            if (tracks.length > 0)
              await addTracksToQueueNext(tracks.map(({ id }) => id));
            setContextMenu(null);
            return tracks.length;
          },
          {
            failureMessage: `Couldn't play album "${album.name}" next.`,
            successMessage: (count) =>
              count > 0 ? `Queued album "${album.name}" to play next` : "",
          },
        );
      },
    },
    {
      label: "Album Info",
      icon: <Info size={14} />,
      onClick: () => {
        setInfoAlbum(album);
        setContextMenu(null);
      },
    },
  ];

  useEffect(() => {
    // Focus input on mount
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchLibrary(query);
        setResults(res);
      } catch (e) {
        console.error("Search failed:", e);
      } finally {
        setIsSearching(false);
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [query]);

  const handlePlaySong = (trackId: string) =>
    runActionWithFeedback(
      async () => {
        await playTrack(trackId);
        setSearchOpen(false);
      },
      { failureMessage: "Couldn't start playback from search." },
    );

  const handleAlbumClick = (album: Album) => {
    setActiveSection("library");
    setActiveLibraryView("albums");
    setSelectedAlbum(album);
    setSearchOpen(false);
  };

  const handleArtistClick = (artist: Artist) => {
    setActiveSection("library");
    setActiveLibraryView("artists");
    setSelectedArtist(artist);
    setSearchOpen(false);
  };

  return (
    <AccessibleDialog
      ariaLabel="Search songs, albums, and artists"
      overlayClassName="modal-overlay animate-fade-in"
      contentClassName="search-modal animate-scale-in glass-panel-heavy"
      onClose={() => setSearchOpen(false)}
    >
      <div className="search-header">
        <Search size={20} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search all songs, albums, and artists…"
          aria-label="Search all songs, albums, and artists"
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="icon-btn"
          aria-label="Close search"
          onClick={() => setSearchOpen(false)}
        >
          <X size={20} />
        </button>
      </div>

      <div className="search-results-wrapper scrollbar-host">
        <div className="search-results" ref={resultsRef}>
          {isSearching ? (
            <div className="empty-state">
              <div className="spinner animate-spin"></div>
              <p>Searching...</p>
            </div>
          ) : !results && !query ? (
            <div className="empty-state">
              <p>
                Search all songs, albums, and artists here. Press / in Songs,
                Albums, or Artists to filter that list.
              </p>
            </div>
          ) : results &&
            results.tracks.length === 0 &&
            results.albums.length === 0 &&
            results.artists.length === 0 ? (
            <div className="empty-state">
              <p>No results found for "{query}"</p>
            </div>
          ) : results ? (
            <div className="search-sections">
              {results.tracks.length > 0 && (
                <div className="search-section">
                  <h3>Songs</h3>
                  <div className="search-list">
                    {results.tracks.slice(0, 5).map((track) => (
                      <SearchTrackItem
                        key={track.id}
                        track={track}
                        onPlay={handlePlaySong}
                        onContextMenu={handleTrackContextMenu}
                      />
                    ))}
                  </div>
                </div>
              )}

              {results.albums.length > 0 && (
                <div className="search-section">
                  <h3>Albums</h3>
                  <div className="search-list">
                    {results.albums.slice(0, 3).map((album, i) => (
                      <SearchAlbumItem
                        key={`album-${i}`}
                        album={album}
                        onClick={() => handleAlbumClick(album)}
                        onContextMenu={handleAlbumContextMenu}
                      />
                    ))}
                  </div>
                </div>
              )}

              {results.artists.length > 0 && (
                <div className="search-section">
                  <h3>Artists</h3>
                  <div className="search-list">
                    {results.artists.slice(0, 3).map((artist, i) => (
                      <SearchArtistItem
                        key={`artist-${i}`}
                        artist={artist}
                        artworkTrackId={
                          artistArtworkIds.get(artist.name) ?? null
                        }
                        onClick={() => handleArtistClick(artist)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
        <CustomScrollbar scrollRef={resultsRef} />
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={
            contextMenu.type === "track"
              ? getTrackContextMenuItems(contextMenu.item)
              : getAlbumContextMenuItems(contextMenu.item)
          }
          onClose={() => setContextMenu(null)}
          returnFocusTo={contextMenu.returnFocusTo}
        />
      )}

      {selectedTrackForPlaylist && (
        <AddToPlaylistModal
          track={selectedTrackForPlaylist}
          onClose={() => setSelectedTrackForPlaylist(null)}
        />
      )}

      {metadataTrack && (
        <TrackMetadataModal
          track={metadataTrack}
          onClose={() => setMetadataTrack(null)}
        />
      )}

      {infoAlbum && (
        <AlbumInfoModal album={infoAlbum} onClose={() => setInfoAlbum(null)} />
      )}
    </AccessibleDialog>
  );
}

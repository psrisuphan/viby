import { useEffect, useState } from 'react';
import { X, Disc } from 'lucide-react';
import type { Album, Track } from '../../types';
import { useArtwork } from '../../utils/useArtwork';
import { getAlbumTracks } from '../../utils/tauri';
import { formatTime } from '../../utils/formatTime';
import './TrackMetadataModal.css';

interface Props {
  album: Album;
  onClose: () => void;
}

interface FieldProps {
  label: string;
  value: string | number | null | undefined;
}

function Field({ label, value }: FieldProps) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="meta-field">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}

export default function AlbumInfoModal({ album, onClose }: Props) {
  const { artworkUrl } = useArtwork(album.artwork_track_id, `${album.name}||${album.artist}`);
  const [tracks, setTracks] = useState<Track[]>([]);

  useEffect(() => {
    getAlbumTracks(album.name, album.artist).then(setTracks).catch(() => {});
  }, [album.name, album.artist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalDuration = tracks.reduce((sum, t) => sum + t.duration_secs, 0);

  const genres = [...new Set(tracks.map(t => t.genre).filter(Boolean))].join(', ');

  const discCount = tracks.length > 0
    ? Math.max(...tracks.map(t => t.disc_number ?? 1))
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content meta-modal glass-panel-heavy" onClick={e => e.stopPropagation()}>

        <button className="meta-close icon-btn" onClick={onClose} title="Close">
          <X size={18} />
        </button>

        <div className="meta-top">
          <div className="meta-artwork">
            {artworkUrl ? (
              <img src={artworkUrl} alt="" className="meta-artwork-img" />
            ) : (
              <div className="meta-artwork-placeholder">
                <Disc size={40} />
              </div>
            )}
          </div>

          <div className="meta-primary">
            <h2 className="meta-title">{album.name}</h2>
            <p className="meta-artist">{album.artist}</p>
            {album.year && <p className="meta-album">{album.year}</p>}
          </div>
        </div>

        <div className="meta-divider" />

        <div className="meta-grid">
          <Field label="Artist"     value={album.artist} />
          <Field label="Year"       value={album.year} />
          <Field label="Tracks"     value={album.track_count} />
          <Field label="Discs"      value={discCount && discCount > 1 ? discCount : null} />
          <Field label="Duration"   value={tracks.length > 0 ? formatTime(totalDuration) : null} />
          <Field label="Genre"      value={genres || null} />
        </div>

      </div>
    </div>
  );
}

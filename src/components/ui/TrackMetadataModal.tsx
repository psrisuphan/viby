import { useEffect } from 'react';
import { X, Music, Disc } from 'lucide-react';
import type { Track } from '../../types';
import { useArtwork } from '../../utils/useArtwork';
import { formatTime, formatFileSize } from '../../utils/formatTime';
import './TrackMetadataModal.css';

interface Props {
  track: Track;
  onClose: () => void;
}

interface FieldProps {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  wrap?: boolean;
}

function Field({ label, value, mono, wrap }: FieldProps) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="meta-field">
      <span className="meta-label">{label}</span>
      <span className={`meta-value ${mono ? 'mono' : ''} ${wrap ? 'wrap' : ''}`}>{value}</span>
    </div>
  );
}

export default function TrackMetadataModal({ track, onClose }: Props) {
  const { artworkUrl } = useArtwork(track.id, `${track.album}||${track.album_artist}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trackDisc =
    track.track_number && track.disc_number && track.disc_number > 1
      ? `${track.track_number} (Disc ${track.disc_number})`
      : track.track_number?.toString() ?? null;

  const dateAdded = track.date_added
    ? new Date(track.date_added).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  const filename = track.file_path.split(/[\\/]/).pop() ?? track.file_path;
  const ext = filename.includes('.') ? filename.split('.').pop()?.toUpperCase() : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content meta-modal glass-panel-heavy" onClick={e => e.stopPropagation()}>

        {/* Close */}
        <button className="meta-close icon-btn" onClick={onClose} title="Close">
          <X size={18} />
        </button>

        {/* Top: artwork + primary info */}
        <div className="meta-top">
          <div className="meta-artwork">
            {artworkUrl ? (
              <img src={artworkUrl} alt="" className="meta-artwork-img" />
            ) : (
              <div className="meta-artwork-placeholder">
                <Music size={40} />
              </div>
            )}
          </div>

          <div className="meta-primary">
            <h2 className="meta-title">{track.title}</h2>
            <p className="meta-artist">{track.artist}</p>
            <p className="meta-album">
              <Disc size={13} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle' }} />
              {track.album}
              {track.year ? ` · ${track.year}` : ''}
            </p>
            {ext && <span className="meta-format-badge">{ext}</span>}
          </div>
        </div>

        {/* Divider */}
        <div className="meta-divider" />

        {/* Metadata grid */}
        <div className="meta-grid">
          <Field label="Artist"       value={track.artist} />
          <Field label="Album Artist" value={track.album_artist !== track.artist ? track.album_artist : null} />
          <Field label="Album"        value={track.album} />
          <Field label="Genre"        value={track.genre} />
          <Field label="Year"         value={track.year} />
          <Field label="Track"        value={trackDisc} />
          <Field label="Duration"     value={formatTime(track.duration_secs)} />
          <Field label="File Size"    value={formatFileSize(track.file_size)} />
          <Field label="Date Added"   value={dateAdded} />
          <Field label="Location"     value={track.file_path} mono wrap />
        </div>
      </div>
    </div>
  );
}

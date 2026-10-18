use rusqlite::{Connection, Result as SqlResult, params};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::models::{Album, Artist, Playlist, TopArtist, Track, TrackEqOverride};

const CURRENT_SCHEMA_VERSION: u32 = 7;
const TRACK_ID_QUERY_CHUNK_SIZE: usize = 500;
const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const TRACK_COLUMNS: &str = "id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,replaygain_track_gain,
                    replaygain_track_peak,normalization_source,file_modified_unix,date_added";

const UPSERT_TRACK: &str = "INSERT INTO tracks
             (id, title, artist, album, album_artist, genre, year, track_number,
              disc_number, duration_secs, file_path, file_size, replaygain_track_gain,
              replaygain_track_peak, normalization_source, file_modified_unix, date_added)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                artist=excluded.artist,
                album=excluded.album,
                album_artist=excluded.album_artist,
                genre=excluded.genre,
                year=excluded.year,
                track_number=excluded.track_number,
                disc_number=excluded.disc_number,
                duration_secs=excluded.duration_secs,
                file_path=excluded.file_path,
                file_size=excluded.file_size,
                replaygain_track_gain=excluded.replaygain_track_gain,
                replaygain_track_peak=excluded.replaygain_track_peak,
                normalization_source=excluded.normalization_source,
                file_modified_unix=excluded.file_modified_unix";

#[derive(Debug, Clone)]
pub struct TrackFingerprint {
    pub id: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_modified_unix: Option<i64>,
    pub date_added: String,
}

// =============================================================================
// Database
// =============================================================================

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    read_conn: Option<Arc<Mutex<Connection>>>,
}

impl Database {
    /// Open (or create) the database and run all pending migrations.
    pub fn open(db_path: impl AsRef<std::path::Path>) -> SqlResult<Self> {
        let db_path = db_path.as_ref();
        let conn = Connection::open(db_path)?;
        conn.busy_timeout(DATABASE_BUSY_TIMEOUT)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        run_migrations(&conn)?;

        let read_conn = if db_path == Path::new(":memory:") {
            None
        } else {
            let read_conn =
                Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            read_conn.busy_timeout(DATABASE_BUSY_TIMEOUT)?;
            read_conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA query_only=ON;")?;
            Some(Arc::new(Mutex::new(read_conn)))
        };

        Ok(Database {
            conn: Arc::new(Mutex::new(conn)),
            read_conn,
        })
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn with_writer_lock_for_test(&self, action: impl FnOnce()) {
        let _writer = self.writer();
        action();
    }

    fn reader(&self) -> MutexGuard<'_, Connection> {
        self.read_conn
            .as_ref()
            .unwrap_or(&self.conn)
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    // =========================================================================
    // Track operations
    // =========================================================================

    pub fn upsert_track(&self, track: &Track) -> SqlResult<()> {
        self.writer().execute(
            UPSERT_TRACK,
            params![
                track.id,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.genre,
                track.year,
                track.track_number,
                track.disc_number,
                track.duration_secs,
                track.file_path,
                track.file_size,
                track.replaygain_track_gain,
                track.replaygain_track_peak,
                track.normalization_source,
                track.file_modified_unix,
                track.date_added,
            ],
        )?;
        Ok(())
    }

    /// Insert a batch of tracks inside a single transaction — much faster than
    /// calling `upsert_track` in a loop for large libraries.
    pub fn upsert_tracks_batch(&self, tracks: &[Track]) -> SqlResult<()> {
        let conn = self.writer();
        let tx =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        {
            let mut stmt = tx.prepare(UPSERT_TRACK)?;
            for track in tracks {
                stmt.execute(params![
                    track.id,
                    track.title,
                    track.artist,
                    track.album,
                    track.album_artist,
                    track.genre,
                    track.year,
                    track.track_number,
                    track.disc_number,
                    track.duration_secs,
                    track.file_path,
                    track.file_size,
                    track.replaygain_track_gain,
                    track.replaygain_track_peak,
                    track.normalization_source,
                    track.file_modified_unix,
                    track.date_added,
                ])?;
            }
        }
        tx.commit()
    }

    pub fn get_all_file_paths(&self) -> SqlResult<Vec<String>> {
        let conn = self.reader();
        let mut stmt = conn.prepare("SELECT file_path FROM tracks")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_track_fingerprints(&self) -> SqlResult<Vec<TrackFingerprint>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare("SELECT id,file_path,file_size,file_modified_unix,date_added FROM tracks")?;
        Ok(stmt
            .query_map([], |row| {
                Ok(TrackFingerprint {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    file_size: row.get(2)?,
                    file_modified_unix: row.get(3)?,
                    date_added: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_tracks_missing_normalization(&self) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks
             WHERE replaygain_track_gain IS NULL
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_number, track_number"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map([], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn update_track_normalization(
        &self,
        id: &str,
        gain_db: f32,
        peak: f32,
        source: &str,
    ) -> SqlResult<()> {
        self.writer().execute(
            "UPDATE tracks
             SET replaygain_track_gain=?1,
                 replaygain_track_peak=?2,
                 normalization_source=?3
             WHERE id=?4",
            params![gain_db, peak, source, id],
        )?;
        Ok(())
    }

    pub fn get_track_eq_override(&self, track_id: &str) -> SqlResult<Option<TrackEqOverride>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT track_id, enabled, preamp_db, gains_json, updated_at
             FROM track_eq_overrides
             WHERE track_id=?1",
        )?;
        let mut rows = stmt.query_map(params![track_id], |row| {
            let gains_json: String = row.get(3)?;
            let gains = serde_json::from_str::<Vec<f32>>(&gains_json).unwrap_or_default();
            Ok(TrackEqOverride {
                track_id: row.get(0)?,
                enabled: row.get::<_, i64>(1)? != 0,
                preamp_db: row.get(2)?,
                gains,
                updated_at: row.get(4)?,
            })
        })?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn save_track_eq_override(&self, override_: &TrackEqOverride) -> SqlResult<()> {
        let gains_json =
            serde_json::to_string(&override_.gains).unwrap_or_else(|_| "[]".to_string());
        self.writer().execute(
            "INSERT INTO track_eq_overrides
             (track_id, enabled, preamp_db, gains_json, updated_at)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(track_id) DO UPDATE SET
                enabled=excluded.enabled,
                preamp_db=excluded.preamp_db,
                gains_json=excluded.gains_json,
                updated_at=excluded.updated_at",
            params![
                override_.track_id,
                if override_.enabled { 1 } else { 0 },
                override_.preamp_db,
                gains_json,
                override_.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_track_eq_override(&self, track_id: &str) -> SqlResult<()> {
        self.writer().execute(
            "DELETE FROM track_eq_overrides WHERE track_id=?1",
            params![track_id],
        )?;
        Ok(())
    }

    pub fn get_track(&self, id: &str) -> SqlResult<Option<Track>> {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id=?1");
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query_map(params![id], Self::row_to_track)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// Resolve a list of IDs in input order while preparing at most one query
    /// per bounded chunk. Missing IDs remain `None` so command boundaries can
    /// reject the full request before mutating playback state.
    pub fn get_tracks_by_ids(&self, ids: &[String]) -> SqlResult<Vec<Option<Track>>> {
        let conn = self.reader();
        let mut tracks_by_id = HashMap::with_capacity(ids.len());
        for chunk in ids.chunks(TRACK_ID_QUERY_CHUNK_SIZE) {
            let placeholders = (1..=chunk.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id IN ({placeholders})");
            let mut statement = conn.prepare_cached(&sql)?;
            let tracks = statement
                .query_map(rusqlite::params_from_iter(chunk.iter()), Self::row_to_track)?
                .collect::<SqlResult<Vec<_>>>()?;
            tracks_by_id.extend(tracks.into_iter().map(|track| (track.id.clone(), track)));
        }

        Ok(ids.iter().map(|id| tracks_by_id.get(id).cloned()).collect())
    }

    pub fn get_track_by_path(&self, file_path: &str) -> SqlResult<Option<Track>> {
        let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE file_path=?1");
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query_map(params![file_path], Self::row_to_track)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn get_all_tracks(&self) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_number, track_number"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map([], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_tracks_by_album(&self, album: &str) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks WHERE album=?1
             ORDER BY disc_number, track_number"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![album], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_tracks_by_album_and_artist(
        &self,
        album: &str,
        album_artist: &str,
    ) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks WHERE album=?1 AND album_artist=?2
             ORDER BY disc_number, track_number"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![album, album_artist], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_tracks_by_artist(&self, artist: &str) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks WHERE artist=?1
             ORDER BY album COLLATE NOCASE, disc_number, track_number"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![artist], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    /// Full-text search using the FTS5 index. Each whitespace-separated token
    /// must prefix-match at least one of: title, artist, album, album_artist, genre.
    pub fn search_tracks(&self, query: &str) -> SqlResult<Vec<Track>> {
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {}
             FROM tracks t
             JOIN tracks_fts ON t.rowid = tracks_fts.rowid
             WHERE tracks_fts MATCH ?1
             ORDER BY rank
             LIMIT 200",
            prefixed_track_columns("t")
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![fts_query], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn delete_track(&self, id: &str) -> SqlResult<()> {
        self.writer()
            .execute("DELETE FROM tracks WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn get_all_track_paths(&self) -> SqlResult<Vec<(String, String)>> {
        let conn = self.reader();
        let mut stmt = conn.prepare("SELECT id, file_path FROM tracks")?;
        Ok(stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    /// Remove tracks absent from successfully walked, non-empty library roots.
    ///
    /// A root is represented by its path and the audio paths found during its
    /// completed walk. Missing/unreadable roots are omitted by the caller, and
    /// empty roots and audio-empty subtrees are protected because offline
    /// volumes can appear as empty mount points below a populated root.
    /// Deletions run in one transaction so a failure cannot leave only part
    /// of a scan's removals applied.
    pub fn remove_missing_tracks_from_scanned_roots(
        &self,
        scanned_roots: &[(String, Vec<String>)],
        audio_empty_subtrees: &[String],
    ) -> SqlResult<usize> {
        use std::path::Path;

        // Prepare scan scope indexes before taking the writer lock. Test file
        // paths by walking their ancestors so the work scales with path depth
        // rather than tracks multiplied by every empty directory.
        let mut protected_candidates: Vec<&Path> = audio_empty_subtrees
            .iter()
            .map(|path| Path::new(path))
            .collect();
        protected_candidates.extend(
            scanned_roots
                .iter()
                .filter(|(_, paths)| paths.is_empty())
                .map(|(root, _)| Path::new(root)),
        );
        let non_empty_roots: Vec<_> = scanned_roots
            .iter()
            .filter(|(_, paths)| !paths.is_empty())
            .collect();
        if non_empty_roots.is_empty() {
            return Ok(0);
        }
        let scanned_root_paths: HashSet<&Path> = non_empty_roots
            .iter()
            .map(|(root, _)| Path::new(root))
            .collect();
        let seen_paths: HashSet<&str> = non_empty_roots
            .iter()
            .flat_map(|(_, paths)| paths.iter().map(String::as_str))
            .collect();
        let mut protected_subtrees = HashSet::with_capacity(protected_candidates.len());
        for protected in protected_candidates {
            let already_covered = protected
                .ancestors()
                .any(|ancestor| protected_subtrees.contains(ancestor));
            if !already_covered {
                protected_subtrees.insert(protected);
            }
        }

        let conn = self.writer();
        let tx =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
        let track_paths = {
            let mut stmt = tx.prepare("SELECT id, file_path FROM tracks")?;
            stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<SqlResult<Vec<_>>>()?
        };
        let stale_ids: Vec<String> = track_paths
            .into_iter()
            .filter(|(_, file_path)| {
                let file = Path::new(file_path);
                let covered_by_scanned_root = file
                    .ancestors()
                    .any(|ancestor| scanned_root_paths.contains(ancestor));
                let protected_by_empty_subtree = file
                    .ancestors()
                    .any(|ancestor| protected_subtrees.contains(ancestor));
                covered_by_scanned_root
                    && !protected_by_empty_subtree
                    && !seen_paths.contains(file_path.as_str())
            })
            .map(|(id, _)| id)
            .collect();

        if stale_ids.is_empty() {
            tx.commit()?;
            return Ok(0);
        }

        for id in &stale_ids {
            tx.execute("DELETE FROM tracks WHERE id=?1", params![id])?;
        }
        tx.commit()?;
        Ok(stale_ids.len())
    }

    // =========================================================================
    // Album & Artist aggregation
    // =========================================================================

    pub fn get_albums(&self) -> SqlResult<Vec<Album>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT album, album_artist, year, COUNT(*) as track_count, MIN(id) as first_track_id
             FROM tracks
             GROUP BY album, album_artist
             ORDER BY album_artist COLLATE NOCASE, year, album COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([], |row| {
                Ok(Album {
                    name: row.get(0)?,
                    artist: row.get(1)?,
                    year: row.get(2)?,
                    track_count: row.get(3)?,
                    artwork_track_id: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_artists(&self) -> SqlResult<Vec<Artist>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT artist,
                    COUNT(DISTINCT album) as album_count,
                    COUNT(*) as track_count
             FROM tracks
             GROUP BY artist
             ORDER BY artist COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([], |row| {
                Ok(Artist {
                    name: row.get(0)?,
                    album_count: row.get(1)?,
                    track_count: row.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn get_genres(&self) -> SqlResult<Vec<String>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT genre FROM tracks
             WHERE genre != 'Unknown'
             ORDER BY genre COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    // =========================================================================
    // Playlist operations
    // =========================================================================

    pub fn create_playlist(&self, playlist: &Playlist) -> SqlResult<()> {
        self.writer().execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1,?2,?3,?4)",
            params![
                playlist.id,
                playlist.name,
                playlist.created_at,
                playlist.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(pt.id) as track_count
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
             GROUP BY p.id
             ORDER BY p.name COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([], |row| {
                Ok(Playlist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    track_count: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn delete_playlist(&self, id: &str) -> SqlResult<()> {
        self.writer()
            .execute("DELETE FROM playlists WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn rename_playlist(&self, id: &str, new_name: &str) -> SqlResult<()> {
        let now = crate::utils::current_timestamp();
        self.writer().execute(
            "UPDATE playlists SET name=?1, updated_at=?2 WHERE id=?3",
            params![new_name, now, id],
        )?;
        Ok(())
    }

    pub fn get_playlist_tracks(&self, playlist_id: &str) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {}
             FROM tracks t
             INNER JOIN playlist_tracks pt ON t.id = pt.track_id
             WHERE pt.playlist_id=?1
             ORDER BY pt.position",
            prefixed_track_columns("t")
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![playlist_id], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn add_tracks_to_playlist(&self, playlist_id: &str, track_ids: &[String]) -> SqlResult<()> {
        let conn = self.writer();
        let tx = conn.unchecked_transaction()?;
        let max_pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id=?1",
            params![playlist_id],
            |row| row.get(0),
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO playlist_tracks (id, playlist_id, track_id, position)
                 VALUES (?1,?2,?3,?4)",
            )?;
            for (position, track_id) in (max_pos + 1..).zip(track_ids) {
                stmt.execute(params![
                    uuid::Uuid::new_v4().to_string(),
                    playlist_id,
                    track_id,
                    position
                ])?;
            }
        }
        let now = crate::utils::current_timestamp();
        tx.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        tx.commit()
    }

    pub fn remove_track_from_playlist(&self, playlist_id: &str, track_id: &str) -> SqlResult<()> {
        let conn = self.writer();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id=?1 AND track_id=?2",
            params![playlist_id, track_id],
        )?;
        let now = crate::utils::current_timestamp();
        conn.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        Ok(())
    }

    pub fn reorder_playlist(&self, playlist_id: &str, track_ids: &[String]) -> SqlResult<()> {
        use std::collections::HashSet;

        let conn = self.writer();
        let tx = conn.unchecked_transaction()?;
        let current = {
            let mut stmt =
                tx.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id=?1")?;
            stmt.query_map(params![playlist_id], |row| row.get::<_, String>(0))?
                .collect::<SqlResult<HashSet<_>>>()?
        };
        let requested: HashSet<&String> = track_ids.iter().collect();
        if requested.len() != track_ids.len()
            || requested.len() != current.len()
            || !track_ids.iter().all(|id| current.contains(id))
        {
            return Err(rusqlite::Error::InvalidQuery);
        }

        {
            let mut stmt = tx.prepare(
                "UPDATE playlist_tracks SET position=?1 WHERE playlist_id=?2 AND track_id=?3",
            )?;
            for (position, track_id) in track_ids.iter().enumerate() {
                stmt.execute(params![position as i64, playlist_id, track_id])?;
            }
        }
        let now = crate::utils::current_timestamp();
        tx.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        tx.commit()
    }

    // =========================================================================
    // Library folder operations
    // =========================================================================

    pub fn add_library_folder(&self, path: &str) -> SqlResult<()> {
        let id = uuid::Uuid::new_v4().to_string();
        self.writer().execute(
            "INSERT OR IGNORE INTO library_folders (id, path) VALUES (?1,?2)",
            params![id, path],
        )?;
        Ok(())
    }

    pub fn remove_library_folder(&self, path: &str) -> SqlResult<()> {
        let conn = self.writer();
        let tx = conn.unchecked_transaction()?;
        let registered = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_folders WHERE path=?1)",
            params![path],
            |row| row.get::<_, bool>(0),
        )?;
        if !registered {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        tx.execute(
            "DELETE FROM tracks
             WHERE file_path=?1
                OR (substr(file_path, 1, length(?1))=?1
                    AND substr(file_path, length(?1) + 1, 1) IN ('/', '\\'))",
            params![path],
        )?;
        tx.execute("DELETE FROM library_folders WHERE path=?1", params![path])?;
        tx.commit()
    }

    pub fn get_library_folders(&self) -> SqlResult<Vec<String>> {
        let conn = self.reader();
        let mut stmt = conn.prepare("SELECT path FROM library_folders ORDER BY path")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    // =========================================================================
    // Play history
    // =========================================================================

    pub fn record_play(&self, track_id: &str) -> SqlResult<()> {
        self.record_play_at(track_id, crate::utils::current_unix_timestamp_seconds())
    }

    pub(crate) fn record_play_at(&self, track_id: &str, played_at: i64) -> SqlResult<()> {
        let conn = self.writer();
        conn.execute(
            "INSERT INTO play_history (track_id, played_at) VALUES (?1, ?2)",
            params![track_id, played_at],
        )?;
        // Keep only the most recent 5,000 rows to prevent unbounded growth.
        conn.execute(
            "DELETE FROM play_history WHERE id NOT IN (
                 SELECT id FROM play_history ORDER BY played_at DESC LIMIT 5000
             )",
            [],
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn play_history_track_ids_for_test(&self) -> SqlResult<Vec<String>> {
        let conn = self.reader();
        let mut stmt = conn.prepare("SELECT track_id FROM play_history ORDER BY id")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    #[cfg(test)]
    pub(crate) fn play_history_entries_for_test(&self) -> SqlResult<Vec<(String, i64)>> {
        let conn = self.reader();
        let mut stmt = conn.prepare("SELECT track_id, played_at FROM play_history ORDER BY id")?;
        Ok(stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    pub fn clear_play_history(&self) -> SqlResult<()> {
        self.writer().execute("DELETE FROM play_history", [])?;
        Ok(())
    }

    /// Return the N most recently played distinct tracks (one entry per track).
    pub fn get_recently_played(&self, limit: usize) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {}
             FROM tracks t
             INNER JOIN play_history ph ON t.id = ph.track_id
             GROUP BY t.id
             ORDER BY MAX(ph.played_at) DESC
             LIMIT ?1",
            prefixed_track_columns("t")
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![limit as i64], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    /// Return the N artists with the most plays, with a sample track ID for artwork.
    pub fn get_top_artists_played(&self, limit: usize) -> SqlResult<Vec<TopArtist>> {
        let conn = self.reader();
        let mut stmt = conn.prepare(
            "SELECT t.artist, COUNT(*) as play_count, MIN(t.id) as artwork_track_id,
                    t.album as artwork_album, t.album_artist as artwork_album_artist
             FROM play_history ph
             INNER JOIN tracks t ON t.id = ph.track_id
             GROUP BY t.artist
             ORDER BY play_count DESC
             LIMIT ?1",
        )?;
        Ok(stmt
            .query_map(params![limit as i64], |row| {
                Ok(TopArtist {
                    name: row.get(0)?,
                    play_count: row.get(1)?,
                    artwork_track_id: row.get(2)?,
                    artwork_album: row.get(3)?,
                    artwork_album_artist: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    /// Return the N most recently added tracks (by date_added).
    pub fn get_recently_added_tracks(&self, limit: usize) -> SqlResult<Vec<Track>> {
        let sql = format!(
            "SELECT {TRACK_COLUMNS}
             FROM tracks
             ORDER BY date_added DESC
             LIMIT ?1"
        );
        let conn = self.reader();
        let mut stmt = conn.prepare(&sql)?;
        Ok(stmt
            .query_map(params![limit as i64], Self::row_to_track)?
            .collect::<SqlResult<Vec<_>>>()?)
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    fn row_to_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
        Ok(Track {
            id: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album: row.get(3)?,
            album_artist: row.get(4)?,
            genre: row.get(5)?,
            year: row.get(6)?,
            track_number: row.get(7)?,
            disc_number: row.get(8)?,
            duration_secs: row.get(9)?,
            file_path: row.get(10)?,
            file_size: row.get(11)?,
            replaygain_track_gain: row.get(12)?,
            replaygain_track_peak: row.get(13)?,
            normalization_source: row.get(14)?,
            file_modified_unix: row.get(15)?,
            date_added: row.get(16)?,
        })
    }
}

fn prefixed_track_columns(alias: &str) -> String {
    TRACK_COLUMNS
        .split(',')
        .map(|column| format!("{alias}.{}", column.trim()))
        .collect::<Vec<_>>()
        .join(",")
}

// =============================================================================
// Migration framework
// =============================================================================

fn schema_version(conn: &Connection) -> SqlResult<u32> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

fn apply_migration<F>(conn: &Connection, target_version: u32, migration: F) -> SqlResult<()>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> SqlResult<()>,
{
    apply_migration_with_version_writer(conn, target_version, migration, |tx, version| {
        tx.execute_batch(&format!("PRAGMA user_version = {version};"))
    })
}

fn apply_migration_with_version_writer<F, W>(
    conn: &Connection,
    target_version: u32,
    migration: F,
    write_version: W,
) -> SqlResult<()>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> SqlResult<()>,
    W: FnOnce(&rusqlite::Transaction<'_>, u32) -> SqlResult<()>,
{
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    migration(&tx)?;
    write_version(&tx, target_version)?;
    tx.commit()
}

fn migration_diagnostic(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
        Some(message.into()),
    )
}

fn with_migration_context(
    result: SqlResult<()>,
    source_version: u32,
    target_version: u32,
    backup_path: Option<&Path>,
) -> SqlResult<()> {
    result.map_err(|error| {
        let backup = backup_path.map_or_else(
            || "no verified on-disk backup was created".to_string(),
            |path| format!("verified pre-migration backup: {}", path.display()),
        );
        migration_diagnostic(format!(
            "database migration from schema version {source_version} to {target_version} failed; {backup}; cause: {error}"
        ))
    })
}

fn main_database_path(conn: &Connection) -> SqlResult<Option<PathBuf>> {
    let path: String = conn.query_row("PRAGMA database_list", [], |row| row.get(2))?;
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

fn has_application_schema(conn: &Connection) -> SqlResult<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
         )",
        [],
        |row| row.get(0),
    )
}

fn migration_backup_path(database_path: &Path) -> PathBuf {
    let mut file_name = database_path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("viby.db"))
        .to_os_string();
    file_name.push(format!(".pre-migration-{}.bak", uuid::Uuid::new_v4()));
    database_path.with_file_name(file_name)
}

/// Create a self-contained SQLite backup and verify its integrity and version.
/// The SQLite backup API includes committed WAL content in its consistent copy.
fn create_verified_migration_backup(conn: &Connection) -> SqlResult<Option<PathBuf>> {
    let Some(database_path) = main_database_path(conn)? else {
        return Ok(None);
    };
    let backup_path = migration_backup_path(&database_path);
    create_verified_migration_backup_at(conn, &backup_path)?;
    Ok(Some(backup_path))
}

fn create_verified_migration_backup_at(conn: &Connection, backup_path: &Path) -> SqlResult<()> {
    let source_version = schema_version(conn)?;

    let backup_result = (|| {
        conn.backup(rusqlite::DatabaseName::Main, backup_path, None)
            .map_err(|error| {
                migration_diagnostic(format!(
                    "could not create pre-migration backup at {} from schema version {source_version}: {error}",
                    backup_path.display()
                ))
            })?;
        verify_migration_backup_at(backup_path, source_version)
    })();

    if let Err(error) = backup_result {
        let _ = std::fs::remove_file(backup_path);
        return Err(error);
    }

    Ok(())
}

fn verify_migration_backup_at(backup_path: &Path, source_version: u32) -> SqlResult<()> {
    let backup = Connection::open(backup_path).map_err(|error| {
        migration_diagnostic(format!(
            "could not open pre-migration backup at {} for verification (expected schema version {source_version}): {error}",
            backup_path.display()
        ))
    })?;
    let integrity: String = backup
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| {
            migration_diagnostic(format!(
                "integrity_check failed for pre-migration backup at {} (source/expected schema version {source_version}): {error}",
                backup_path.display()
            ))
        })?;
    let backup_version = schema_version(&backup).map_err(|error| {
        migration_diagnostic(format!(
            "could not read schema version from pre-migration backup at {} (detected integrity_check={integrity:?}, expected schema version {source_version}): {error}",
            backup_path.display()
        ))
    })?;
    if integrity != "ok" || backup_version != source_version {
        return Err(migration_diagnostic(format!(
            "pre-migration backup verification failed at {}: detected integrity_check={integrity:?}, detected schema version {backup_version}, expected schema version {source_version}",
            backup_path.display()
        )));
    }

    Ok(())
}

/// Run all pending migrations in order. Each migration and its version bump
/// commit atomically; failures roll back the schema changes for that version.
fn run_migrations(conn: &Connection) -> SqlResult<()> {
    run_migrations_with_hooks(
        conn,
        create_verified_migration_backup,
        || Ok(()),
        |tx, version| tx.execute_batch(&format!("PRAGMA user_version = {version};")),
    )
}

fn run_migrations_with_hooks<B, H, V>(
    conn: &Connection,
    create_backup: B,
    after_v5_first_alter: H,
    write_v5_version: V,
) -> SqlResult<()>
where
    B: FnOnce(&Connection) -> SqlResult<Option<PathBuf>>,
    H: FnOnce() -> SqlResult<()>,
    V: FnOnce(&rusqlite::Transaction<'_>, u32) -> SqlResult<()>,
{
    let mut version = schema_version(conn)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(migration_diagnostic(format!(
            "database schema version {version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
        )));
    }
    let backup_path = if version < CURRENT_SCHEMA_VERSION && has_application_schema(conn)? {
        let backup = create_backup(conn).map_err(|error| {
            migration_diagnostic(format!(
                "could not create a verified pre-migration backup for source schema version {version} (expected supported version {CURRENT_SCHEMA_VERSION}): {error}"
            ))
        })?;
        if let Some(path) = &backup {
            eprintln!(
                "[Database] Using verified pre-migration backup at {}",
                path.display()
            );
        }
        backup
    } else {
        None
    };

    if version < 1 {
        with_migration_context(
            apply_migration(conn, 1, |tx| {
                tx.execute_batch(
                    "
                CREATE TABLE IF NOT EXISTS tracks (
                    id              TEXT PRIMARY KEY,
                    title           TEXT NOT NULL,
                    artist          TEXT NOT NULL DEFAULT 'Unknown Artist',
                    album           TEXT NOT NULL DEFAULT 'Unknown Album',
                    album_artist    TEXT NOT NULL DEFAULT 'Unknown Artist',
                    genre           TEXT NOT NULL DEFAULT 'Unknown',
                    year            INTEGER,
                    track_number    INTEGER,
                    disc_number     INTEGER,
                    duration_secs   REAL NOT NULL DEFAULT 0.0,
                    file_path       TEXT NOT NULL UNIQUE,
                    file_size       INTEGER NOT NULL DEFAULT 0,
                    artwork_hash    TEXT,
                    date_added      TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
                CREATE INDEX IF NOT EXISTS idx_tracks_artist    ON tracks(artist);
                CREATE INDEX IF NOT EXISTS idx_tracks_album     ON tracks(album);

                CREATE TABLE IF NOT EXISTS playlists (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS playlist_tracks (
                    id          TEXT PRIMARY KEY,
                    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                    track_id    TEXT NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
                    position    INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS library_folders (
                    id   TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE
                );
                ",
                )
            }),
            version,
            1,
            backup_path.as_deref(),
        )?;
        version = 1;
    }

    if version < 2 {
        with_migration_context(
            apply_migration(conn, 2, |tx| {
                // FTS5 mirrors the searchable track fields and stays in sync through triggers.
                tx.execute_batch(
                "
                CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                    title, artist, album, album_artist, genre,
                    content=tracks,
                    content_rowid=rowid
                );

                CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
                    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
                    VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
                END;

                CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
                    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
                    VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
                END;

                CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
                    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
                    VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
                    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
                    VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
                END;

                INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
                    SELECT rowid, title, artist, album, album_artist, genre FROM tracks;
                ",
            )
            }),
            version,
            2,
            backup_path.as_deref(),
        )?;
        version = 2;
    }

    if version < 3 {
        with_migration_context(
            apply_migration(conn, 3, |tx| {
                tx.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS play_history (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_id  TEXT    NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                    played_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);
                CREATE INDEX IF NOT EXISTS idx_play_history_track_id  ON play_history(track_id);
                ",
            )
            }),
            version,
            3,
            backup_path.as_deref(),
        )?;
        version = 3;
    }

    if version < 4 {
        with_migration_context(
            apply_migration(conn, 4, |tx| {
                tx.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album, album_artist);",
            )
            }),
            version,
            4,
            backup_path.as_deref(),
        )?;
        version = 4;
    }

    if version < 5 {
        let mut after_v5_first_alter = Some(after_v5_first_alter);
        let mut write_v5_version = Some(write_v5_version);
        with_migration_context(
            apply_migration_with_version_writer(
                conn,
                5,
                |tx| {
                    tx.execute_batch("ALTER TABLE tracks ADD COLUMN replaygain_track_gain REAL;")?;
                    after_v5_first_alter
                        .take()
                        .expect("v5 hook should run once")()?;
                    tx.execute_batch(
                        "
                ALTER TABLE tracks ADD COLUMN replaygain_track_peak REAL;
                ALTER TABLE tracks ADD COLUMN normalization_source TEXT;
                ALTER TABLE tracks ADD COLUMN file_modified_unix INTEGER;
                ",
                    )
                },
                |tx, version| {
                    write_v5_version
                        .take()
                        .expect("v5 version writer should run once")(tx, version)
                },
            ),
            version,
            5,
            backup_path.as_deref(),
        )?;
        version = 5;
    }

    if version < 6 {
        with_migration_context(
            apply_migration(conn, 6, |tx| {
                tx.execute_batch(
                    "
                CREATE TABLE IF NOT EXISTS track_eq_overrides (
                    track_id   TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                    enabled    INTEGER NOT NULL,
                    preamp_db  REAL NOT NULL,
                    gains_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                ",
                )
            }),
            version,
            6,
            backup_path.as_deref(),
        )?;
        version = 6;
    }

    if version < 7 {
        with_migration_context(
            apply_migration(conn, 7, |tx| {
                tx.execute_batch(
                    "
                DROP INDEX IF EXISTS idx_tracks_file_path;
                CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position
                    ON playlist_tracks(playlist_id, position);
                CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track_id
                    ON playlist_tracks(track_id);
                ",
                )
            }),
            version,
            7,
            backup_path.as_deref(),
        )?;
    }

    Ok(())
}

/// Build an FTS5 MATCH query from a user search string.
/// Each whitespace-separated token becomes a quoted prefix term so that
/// "norah jones" produces `"norah"* "jones"*` (both tokens must match).
fn build_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_in_memory() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        run_migrations(&conn).unwrap();
        Database {
            conn: Arc::new(Mutex::new(conn)),
            read_conn: None,
        }
    }

    fn sample_track(id: &str, path: &str) -> Track {
        Track {
            id: id.to_string(),
            title: format!("Track {}", id),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Rock".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 200.0,
            file_path: path.to_string(),
            file_size: 2048,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: Some(1_704_067_200),
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn test_database_dir() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("viby-migration-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn prepare_v4_database_with_user_data(database_path: &Path) {
        use crate::models::Playlist;

        let db = Database::open(database_path).unwrap();
        let track = sample_track("migration-track", "/music/migration.mp3");
        db.upsert_track(&track).unwrap();
        db.create_playlist(&Playlist {
            id: "migration-playlist".to_string(),
            name: "Keep through migration".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.add_tracks_to_playlist("migration-playlist", &[track.id])
            .unwrap();
        db.record_play("migration-track").unwrap();
        drop(db);

        // Rewind this fully populated database to the real v4 shape. This
        // gives tests a valid pre-v5 application schema with user data.
        let conn = Connection::open(database_path).unwrap();
        conn.execute_batch(
            "DROP TABLE track_eq_overrides;
             ALTER TABLE tracks DROP COLUMN file_modified_unix;
             ALTER TABLE tracks DROP COLUMN normalization_source;
             ALTER TABLE tracks DROP COLUMN replaygain_track_peak;
             ALTER TABLE tracks DROP COLUMN replaygain_track_gain;
             PRAGMA user_version=4;",
        )
        .unwrap();
    }

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap()
            .iter()
            .any(|name| name == column)
    }

    fn schema_signature(conn: &Connection) -> Vec<(String, String)> {
        let mut statement = conn
            .prepare(
                "SELECT name, COALESCE(sql, '') FROM sqlite_schema
                 WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap()
    }

    fn find_migration_backup(database_path: &Path) -> PathBuf {
        let prefix = format!(
            "{}.pre-migration-",
            database_path.file_name().unwrap().to_string_lossy()
        );
        std::fs::read_dir(database_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            })
            .expect("migration should leave a verified pre-migration backup")
    }

    #[test]
    fn supported_v1_schema_migrates_and_keeps_a_verified_backup() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        {
            let conn = Connection::open(&database_path).unwrap();
            conn.execute_batch(
                "
                PRAGMA foreign_keys=ON;
                CREATE TABLE tracks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL DEFAULT 'Unknown Artist',
                    album TEXT NOT NULL DEFAULT 'Unknown Album',
                    album_artist TEXT NOT NULL DEFAULT 'Unknown Artist',
                    genre TEXT NOT NULL DEFAULT 'Unknown',
                    year INTEGER,
                    track_number INTEGER,
                    disc_number INTEGER,
                    duration_secs REAL NOT NULL DEFAULT 0.0,
                    file_path TEXT NOT NULL UNIQUE,
                    file_size INTEGER NOT NULL DEFAULT 0,
                    artwork_hash TEXT,
                    date_added TEXT NOT NULL
                );
                CREATE TABLE playlists (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE playlist_tracks (
                    id TEXT PRIMARY KEY,
                    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL
                );
                CREATE TABLE library_folders (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE
                );
                INSERT INTO tracks (
                    id, title, artist, album, album_artist, genre, duration_secs,
                    file_path, file_size, date_added
                ) VALUES (
                    'legacy', 'Legacy Track', 'Legacy Artist', 'Legacy Album',
                    'Legacy Artist', 'Rock', 180.0, '/music/legacy.mp3', 4096,
                    '2024-01-01T00:00:00Z'
                );
                INSERT INTO playlists (
                    id, name, created_at, updated_at
                ) VALUES (
                    'legacy-list', 'Legacy Playlist', '2024-01-01T00:00:00Z',
                    '2024-01-01T00:00:00Z'
                );
                INSERT INTO playlist_tracks (id, playlist_id, track_id, position)
                VALUES ('legacy-entry', 'legacy-list', 'legacy', 0);
                INSERT INTO library_folders (id, path)
                VALUES ('legacy-folder', '/music');
                PRAGMA user_version=1;
                ",
            )
            .unwrap();
        }

        let db = Database::open(&database_path).unwrap();
        assert_eq!(
            schema_version(&db.writer()).unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            db.get_track("legacy").unwrap().unwrap().title,
            "Legacy Track"
        );
        assert_eq!(db.get_playlist_tracks("legacy-list").unwrap().len(), 1);
        assert_eq!(db.get_library_folders().unwrap(), vec!["/music"]);
        assert_eq!(db.search_tracks("Legacy").unwrap().len(), 1);

        let backup_path = find_migration_backup(&database_path);
        let backup = Connection::open(&backup_path).unwrap();
        let integrity: String = backup
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(schema_version(&backup).unwrap(), 1);
        assert_eq!(
            backup
                .query_row("SELECT title FROM tracks WHERE id='legacy'", [], |row| {
                    row.get::<_, String>(0)
                },)
                .unwrap(),
            "Legacy Track"
        );
        assert_eq!(
            backup
                .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );

        drop(backup);
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migration_backup_includes_committed_wal_data_with_source_open() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        let conn = Connection::open(&database_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE marker (value TEXT NOT NULL);
             INSERT INTO marker VALUES ('committed in WAL');
             PRAGMA user_version=4;",
        )
        .unwrap();

        let wal_path = PathBuf::from(format!("{}-wal", database_path.display()));
        assert!(wal_path.metadata().unwrap().len() > 32);
        let backup_path = create_verified_migration_backup(&conn).unwrap().unwrap();
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(schema_version(&backup).unwrap(), 4);
        assert_eq!(
            backup
                .query_row("SELECT value FROM marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "committed in WAL"
        );

        drop(backup);
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backup_verification_error_reports_integrity_version_and_path() {
        let directory = test_database_dir();
        let backup_path = directory.join("unexpected-version.bak");
        let backup = Connection::open(&backup_path).unwrap();
        backup
            .execute_batch("CREATE TABLE marker (value TEXT); PRAGMA user_version=3;")
            .unwrap();
        drop(backup);

        let error = verify_migration_backup_at(&backup_path, 4)
            .unwrap_err()
            .to_string();
        assert!(error.contains("integrity_check=\"ok\""), "{error}");
        assert!(error.contains("detected schema version 3"), "{error}");
        assert!(error.contains("expected schema version 4"), "{error}");
        assert!(
            error.contains(&backup_path.display().to_string()),
            "{error}"
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backup_error_aborts_migration_without_changing_schema_or_data() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        prepare_v4_database_with_user_data(&database_path);
        let conn = Connection::open(&database_path).unwrap();
        let schema_before = schema_signature(&conn);
        let missing_parent_backup_path = directory.join("missing-parent").join("failed.bak");

        let result = run_migrations_with_hooks(
            &conn,
            |source| {
                create_verified_migration_backup_at(source, &missing_parent_backup_path)?;
                Ok(Some(missing_parent_backup_path.clone()))
            },
            || Ok(()),
            |tx, version| tx.execute_batch(&format!("PRAGMA user_version = {version};")),
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("source schema version 4"), "{error}");
        assert!(
            error.contains(&missing_parent_backup_path.display().to_string()),
            "{error}"
        );
        assert_eq!(schema_version(&conn).unwrap(), 4);
        assert_eq!(schema_signature(&conn), schema_before);
        assert_eq!(
            conn.query_row(
                "SELECT title FROM tracks WHERE id='migration-track'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Track migration-track"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM playlist_tracks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM play_history", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!has_column(&conn, "tracks", "replaygain_track_gain"));
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn actual_v5_migration_failure_rolls_back_and_retries_after_reopen() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        prepare_v4_database_with_user_data(&database_path);

        let conn = Connection::open(&database_path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 4);
        assert!(!has_column(&conn, "tracks", "replaygain_track_gain"));
        let failed = run_migrations_with_hooks(
            &conn,
            create_verified_migration_backup,
            || Err(migration_diagnostic("injected after first v5 ALTER")),
            |tx, version| tx.execute_batch(&format!("PRAGMA user_version = {version};")),
        );
        let error = failed.unwrap_err().to_string();
        assert!(
            error.contains("migration from schema version 4 to 5 failed"),
            "{error}"
        );
        assert!(error.contains("verified pre-migration backup:"), "{error}");
        assert!(error.contains("injected after first v5 ALTER"), "{error}");
        assert_eq!(schema_version(&conn).unwrap(), 4);
        for column in [
            "replaygain_track_gain",
            "replaygain_track_peak",
            "normalization_source",
            "file_modified_unix",
        ] {
            assert!(!has_column(&conn, "tracks", column));
        }
        assert_eq!(
            conn.query_row(
                "SELECT title FROM tracks WHERE id='migration-track'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Track migration-track"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM playlist_tracks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM play_history", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);

        let reopened = Database::open(&database_path).unwrap();
        assert_eq!(
            schema_version(&reopened.writer()).unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        for column in [
            "replaygain_track_gain",
            "replaygain_track_peak",
            "normalization_source",
            "file_modified_unix",
        ] {
            assert!(has_column(&reopened.writer(), "tracks", column));
        }
        assert_eq!(
            reopened
                .get_track("migration-track")
                .unwrap()
                .unwrap()
                .title,
            "Track migration-track"
        );
        assert_eq!(
            reopened
                .get_playlist_tracks("migration-playlist")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(reopened.get_recently_played(10).unwrap().len(), 1);
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn actual_v5_version_bump_failure_rolls_back_and_retries_after_reopen() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        prepare_v4_database_with_user_data(&database_path);

        let conn = Connection::open(&database_path).unwrap();
        let failed = run_migrations_with_hooks(
            &conn,
            create_verified_migration_backup,
            || Ok(()),
            |_, version| {
                assert_eq!(version, 5);
                Err(migration_diagnostic(
                    "injected v5 user_version write failure",
                ))
            },
        );
        let error = failed.unwrap_err().to_string();
        assert!(
            error.contains("migration from schema version 4 to 5 failed"),
            "{error}"
        );
        assert!(error.contains("verified pre-migration backup:"), "{error}");
        assert!(
            error.contains("injected v5 user_version write failure"),
            "{error}"
        );
        assert_eq!(schema_version(&conn).unwrap(), 4);
        for column in [
            "replaygain_track_gain",
            "replaygain_track_peak",
            "normalization_source",
            "file_modified_unix",
        ] {
            assert!(!has_column(&conn, "tracks", column));
        }
        assert_eq!(
            conn.query_row(
                "SELECT title FROM tracks WHERE id='migration-track'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Track migration-track"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM playlist_tracks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM play_history", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);

        let reopened = Database::open(&database_path).unwrap();
        assert_eq!(
            schema_version(&reopened.writer()).unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        for column in [
            "replaygain_track_gain",
            "replaygain_track_peak",
            "normalization_source",
            "file_modified_unix",
        ] {
            assert!(has_column(&reopened.writer(), "tracks", column));
        }
        assert_eq!(reopened.get_recently_played(10).unwrap().len(), 1);
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn future_schema_error_reports_detected_and_supported_versions() {
        let conn = Connection::open_in_memory().unwrap();
        let detected_version = CURRENT_SCHEMA_VERSION + 1;
        conn.execute_batch(&format!("PRAGMA user_version={detected_version};"))
            .unwrap();

        let error = run_migrations_with_hooks(
            &conn,
            |_| Ok(None),
            || Ok(()),
            |tx, version| tx.execute_batch(&format!("PRAGMA user_version = {version};")),
        )
        .unwrap_err()
        .to_string();

        assert!(
            error.contains(&format!("schema version {detected_version}")),
            "{error}"
        );
        assert!(
            error.contains(&format!("supported version {CURRENT_SCHEMA_VERSION}")),
            "{error}"
        );
    }

    #[test]
    fn migration_failure_rolls_back_and_can_retry_after_reopen() {
        let directory = test_database_dir();
        let database_path = directory.join("library.db");
        let conn = Connection::open(&database_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE marker (value TEXT NOT NULL);
             INSERT INTO marker VALUES ('preserved');
             PRAGMA user_version=1;",
        )
        .unwrap();

        let failed = apply_migration(&conn, 2, |tx| {
            tx.execute_batch("CREATE TABLE rolled_back (value TEXT);")?;
            tx.execute_batch("INSERT INTO missing_table VALUES ('fail');")
        });
        assert!(failed.is_err());
        assert_eq!(schema_version(&conn).unwrap(), 1);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='rolled_back'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        drop(conn);

        let reopened = Connection::open(&database_path).unwrap();
        apply_migration(&reopened, 2, |tx| {
            tx.execute_batch("CREATE TABLE recovered (value TEXT);")
        })
        .unwrap();
        assert_eq!(schema_version(&reopened).unwrap(), 2);
        drop(reopened);

        let verified = Connection::open(&database_path).unwrap();
        assert_eq!(schema_version(&verified).unwrap(), 2);
        assert_eq!(
            verified
                .query_row("SELECT value FROM marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        assert_eq!(
            verified
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name='recovered'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(verified);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn schema_version_5_adds_normalization_columns() {
        let db = open_in_memory();
        let t = sample_track("norm", "/music/norm.mp3");
        db.upsert_track(&t).unwrap();
        let loaded = db.get_track("norm").unwrap().unwrap();
        assert_eq!(loaded.replaygain_track_gain, None);
        assert_eq!(loaded.replaygain_track_peak, None);
    }

    #[test]
    fn track_eq_override_round_trips_and_deletes() {
        let db = open_in_memory();
        let t = sample_track("eq", "/music/eq.mp3");
        db.upsert_track(&t).unwrap();

        let override_ = TrackEqOverride {
            track_id: "eq".to_string(),
            enabled: true,
            preamp_db: -3.0,
            gains: vec![0.0, 1.0, 2.0, 3.0, 4.0, -1.0, -2.0, -3.0, -4.0, 0.5],
            updated_at: "2024-01-02T00:00:00Z".to_string(),
        };

        db.save_track_eq_override(&override_).unwrap();
        let loaded = db.get_track_eq_override("eq").unwrap().unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.preamp_db, -3.0);
        assert_eq!(loaded.gains, override_.gains);

        db.delete_track_eq_override("eq").unwrap();
        assert!(db.get_track_eq_override("eq").unwrap().is_none());
    }

    #[test]
    fn version_7_adds_playlist_indexes_and_removes_redundant_path_index() {
        let db = open_in_memory();

        let redundant_path_index: i64 = db
            .writer()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name='idx_tracks_file_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(redundant_path_index, 0);

        for index_name in [
            "idx_playlist_tracks_playlist_position",
            "idx_playlist_tracks_track_id",
        ] {
            let present: i64 = db
                .writer()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name=?1",
                    [index_name],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(present, 1, "expected index {index_name}");
        }

        let playlist_plan: String = db
            .writer()
            .query_row(
                "EXPLAIN QUERY PLAN SELECT track_id FROM playlist_tracks
                 WHERE playlist_id='playlist' ORDER BY position",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            playlist_plan.contains("idx_playlist_tracks_playlist_position"),
            "playlist retrieval should use its composite index: {playlist_plan}"
        );

        let track_id_plan: String = db
            .writer()
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM playlist_tracks WHERE track_id='track'",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            track_id_plan.contains("idx_playlist_tracks_track_id"),
            "track relationship lookup should use its index: {track_id_plan}"
        );
    }

    #[test]
    fn batched_track_lookup_preserves_order_duplicates_and_missing_ids() {
        let db = open_in_memory();
        let tracks = (0..=TRACK_ID_QUERY_CHUNK_SIZE)
            .map(|index| sample_track(&format!("track-{index}"), &format!("/music/{index}.mp3")))
            .collect::<Vec<_>>();
        db.upsert_tracks_batch(&tracks).unwrap();

        let mut requested = (0..=TRACK_ID_QUERY_CHUNK_SIZE)
            .map(|index| format!("track-{index}"))
            .collect::<Vec<_>>();
        requested.push("track-0".to_string());
        requested.push("missing".to_string());
        let resolved = db.get_tracks_by_ids(&requested).unwrap();

        assert_eq!(resolved.len(), requested.len());
        for (index, track) in resolved[..=TRACK_ID_QUERY_CHUNK_SIZE].iter().enumerate() {
            assert_eq!(track.as_ref().unwrap().id, format!("track-{index}"));
        }
        assert_eq!(
            resolved[TRACK_ID_QUERY_CHUNK_SIZE + 1].as_ref().unwrap().id,
            "track-0"
        );
        assert!(resolved[TRACK_ID_QUERY_CHUNK_SIZE + 2].is_none());
    }

    #[test]
    fn open_configures_sqlite_busy_timeout() {
        let directory = test_database_dir();
        let db = Database::open(directory.join("library.db")).unwrap();
        let writer_timeout_ms: u32 = db
            .writer()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        let reader_timeout_ms: u32 = db
            .reader()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        let query_only: bool = db
            .reader()
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();

        assert_eq!(writer_timeout_ms, DATABASE_BUSY_TIMEOUT.as_millis() as u32);
        assert_eq!(reader_timeout_ms, DATABASE_BUSY_TIMEOUT.as_millis() as u32);
        assert!(query_only);
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn playback_read_completes_during_scan_write_transaction() {
        use std::sync::{Arc, mpsc};

        let directory = test_database_dir();
        let db = Arc::new(Database::open(directory.join("library.db")).unwrap());
        db.upsert_track(&sample_track("current", "/music/current.mp3"))
            .unwrap();

        let (write_started_tx, write_started_rx) = mpsc::channel();
        let (finish_write_tx, finish_write_rx) = mpsc::channel();
        let writer_db = Arc::clone(&db);
        let writer = std::thread::spawn(move || {
            let conn = writer_db.writer();
            let tx = rusqlite::Transaction::new_unchecked(
                &conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            tx.execute(
                "UPDATE tracks SET title='Uncommitted title' WHERE id='current'",
                [],
            )
            .unwrap();
            write_started_tx.send(()).unwrap();
            finish_write_rx.recv().unwrap();
            tx.commit().unwrap();
        });

        write_started_rx.recv().unwrap();
        let (read_result_tx, read_result_rx) = mpsc::channel();
        let reader_db = Arc::clone(&db);
        let reader = std::thread::spawn(move || {
            let result = reader_db.get_track("current").unwrap();
            read_result_tx.send(result).unwrap();
        });
        let current = read_result_rx
            .recv_timeout(Duration::from_millis(500))
            .expect("playback read should not wait for the scan write transaction")
            .unwrap();
        assert_eq!(current.title, "Track current");

        finish_write_tx.send(()).unwrap();
        writer.join().unwrap();
        reader.join().unwrap();
        assert_eq!(
            db.get_track("current").unwrap().unwrap().title,
            "Uncommitted title"
        );
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn upsert_is_idempotent() {
        let db = open_in_memory();
        let t = sample_track("abc", "/music/a.mp3");
        db.upsert_track(&t).unwrap();
        db.upsert_track(&t).unwrap(); // second insert = replace
        let all = db.get_all_tracks().unwrap();
        assert_eq!(
            all.len(),
            1,
            "Duplicate upsert should result in exactly 1 row"
        );
    }

    #[test]
    fn upsert_preserves_track_relationships() {
        use crate::models::Playlist;

        let db = open_in_memory();
        let mut track = sample_track("related", "/music/related.mp3");
        db.upsert_track(&track).unwrap();
        db.create_playlist(&Playlist {
            id: "playlist".to_string(),
            name: "Keep me".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.add_tracks_to_playlist("playlist", &[track.id.clone()])
            .unwrap();
        db.record_play(&track.id).unwrap();
        db.save_track_eq_override(&TrackEqOverride {
            track_id: track.id.clone(),
            enabled: true,
            preamp_db: -2.0,
            gains: vec![0.0; 10],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();

        track.title = "Updated title".to_string();
        db.upsert_track(&track).unwrap();

        assert_eq!(db.get_playlist_tracks("playlist").unwrap().len(), 1);
        assert_eq!(db.get_recently_played(10).unwrap().len(), 1);
        assert!(db.get_track_eq_override(&track.id).unwrap().is_some());
        assert_eq!(
            db.get_track(&track.id).unwrap().unwrap().title,
            "Updated title"
        );
    }

    #[test]
    fn reorder_playlist_rejects_incomplete_or_duplicate_ids() {
        use crate::models::Playlist;

        let db = open_in_memory();
        db.upsert_track(&sample_track("one", "/music/one.mp3"))
            .unwrap();
        db.upsert_track(&sample_track("two", "/music/two.mp3"))
            .unwrap();
        db.create_playlist(&Playlist {
            id: "playlist".to_string(),
            name: "Test".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.add_tracks_to_playlist("playlist", &["one".to_string(), "two".to_string()])
            .unwrap();

        assert!(
            db.reorder_playlist("playlist", &["one".to_string()])
                .is_err()
        );
        assert!(
            db.reorder_playlist("playlist", &["one".to_string(), "one".to_string()])
                .is_err()
        );
        assert!(
            db.reorder_playlist("playlist", &["two".to_string(), "one".to_string()])
                .is_ok()
        );
        assert_eq!(db.get_playlist_tracks("playlist").unwrap()[0].id, "two");
    }

    #[test]
    fn get_all_file_paths_returns_correct_paths() {
        let db = open_in_memory();
        db.upsert_track(&sample_track("1", "/music/a.mp3")).unwrap();
        db.upsert_track(&sample_track("2", "/music/b.mp3")).unwrap();
        let paths = db.get_all_file_paths().unwrap();
        assert!(paths.contains(&"/music/a.mp3".to_string()));
        assert!(paths.contains(&"/music/b.mp3".to_string()));
    }

    #[test]
    fn removing_library_folder_does_not_remove_sibling_prefixes() {
        let db = open_in_memory();
        db.add_library_folder("/music").unwrap();
        db.upsert_track(&sample_track("child", "/music/album/song.mp3"))
            .unwrap();
        db.upsert_track(&sample_track("sibling", "/music-old/song.mp3"))
            .unwrap();

        db.remove_library_folder("/music").unwrap();

        assert!(db.get_track("child").unwrap().is_none());
        assert!(db.get_track("sibling").unwrap().is_some());
    }

    #[test]
    fn cannot_remove_an_unregistered_library_folder() {
        let db = open_in_memory();
        db.upsert_track(&sample_track("track", "/music/song.mp3"))
            .unwrap();

        assert!(db.remove_library_folder("/music").is_err());
        assert!(db.get_track("track").unwrap().is_some());
    }

    #[test]
    fn pruning_uses_real_scan_results_and_respects_path_boundaries() {
        let db = open_in_memory();
        let root = std::env::temp_dir().join(format!("viby-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let keep_path = root.join("keep.mp3");
        std::fs::write(&keep_path, b"present").unwrap();
        let root_string = root.to_string_lossy().into_owned();
        let keep_string = keep_path.to_string_lossy().into_owned();
        let stale_string = root.join("removed.mp3").to_string_lossy().into_owned();
        let sibling_string = root
            .with_file_name(format!(
                "{}-archive",
                root.file_name().unwrap().to_string_lossy()
            ))
            .join("keep.mp3")
            .to_string_lossy()
            .into_owned();

        db.upsert_track(&sample_track("keep", &keep_string))
            .unwrap();
        db.upsert_track(&sample_track("removed", &stale_string))
            .unwrap();
        db.upsert_track(&sample_track("sibling", &sibling_string))
            .unwrap();

        let scan = crate::library::scanner::scan_directory_with_subtrees(&root_string).unwrap();
        assert_eq!(scan.audio_files, vec![keep_string.clone()]);
        let removed = db
            .remove_missing_tracks_from_scanned_roots(&[(root_string, scan.audio_files)], &[])
            .unwrap();

        assert_eq!(removed, 1);
        assert!(db.get_track("keep").unwrap().is_some());
        assert!(db.get_track("removed").unwrap().is_none());
        assert!(db.get_track("sibling").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_audio_empty_subtrees_preserve_tracks_and_user_data() {
        use crate::models::Playlist;

        let db = open_in_memory();
        let root =
            std::env::temp_dir().join(format!("viby-nested-offline-{}", uuid::Uuid::new_v4()));
        let unregistered_mount = root.join("offline-unregistered");
        let registered_mount = root.join("offline-registered");
        std::fs::create_dir_all(&unregistered_mount).unwrap();
        std::fs::create_dir_all(&registered_mount).unwrap();
        let present_path = root.join("present.mp3");
        std::fs::write(&present_path, b"present").unwrap();

        let unregistered_path = unregistered_mount.join("song.mp3");
        let registered_path = registered_mount.join("song.mp3");
        let unregistered =
            sample_track("offline-unregistered", unregistered_path.to_str().unwrap());
        let registered = sample_track("offline-registered", registered_path.to_str().unwrap());
        db.upsert_track(&unregistered).unwrap();
        db.upsert_track(&registered).unwrap();
        db.create_playlist(&Playlist {
            id: "nested-offline-playlist".to_string(),
            name: "Keep nested offline tracks".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.add_tracks_to_playlist(
            "nested-offline-playlist",
            &[unregistered.id.clone(), registered.id.clone()],
        )
        .unwrap();
        db.record_play(&unregistered.id).unwrap();
        db.record_play(&registered.id).unwrap();
        for track in [&unregistered, &registered] {
            db.save_track_eq_override(&TrackEqOverride {
                track_id: track.id.clone(),
                enabled: true,
                preamp_db: -2.0,
                gains: vec![0.0; 10],
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            })
            .unwrap();
        }

        let root_string = root.to_string_lossy().into_owned();
        let registered_string = registered_mount.to_string_lossy().into_owned();
        let parent_scan =
            crate::library::scanner::scan_directory_with_subtrees(&root_string).unwrap();
        assert_eq!(
            parent_scan.audio_files,
            vec![present_path.to_string_lossy().into_owned()]
        );
        assert!(
            parent_scan
                .audio_empty_subtrees
                .contains(&unregistered_mount.to_string_lossy().into_owned())
        );
        assert!(
            parent_scan
                .audio_empty_subtrees
                .contains(&registered_string)
        );

        // A nested mount that is not a configured root is protected by the
        // parent's full walk, even while another directory contains audio.
        assert_eq!(
            db.remove_missing_tracks_from_scanned_roots(
                &[(root_string.clone(), parent_scan.audio_files.clone())],
                &parent_scan.audio_empty_subtrees,
            )
            .unwrap(),
            0
        );

        // The explicit empty nested root is protected as well; it must not be
        // overridden by the populated parent's broader starts_with scope.
        assert_eq!(
            db.remove_missing_tracks_from_scanned_roots(
                &[
                    (root_string, parent_scan.audio_files),
                    (registered_string, Vec::new()),
                ],
                &parent_scan.audio_empty_subtrees,
            )
            .unwrap(),
            0
        );

        for track in [&unregistered, &registered] {
            assert!(db.get_track(&track.id).unwrap().is_some());
            assert!(db.get_track_eq_override(&track.id).unwrap().is_some());
        }
        assert_eq!(
            db.get_playlist_tracks("nested-offline-playlist")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(db.get_recently_played(10).unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unavailable_and_empty_roots_preserve_tracks_and_user_data() {
        use crate::models::Playlist;

        let db = open_in_memory();
        let track = sample_track("offline", "/offline/music/song.mp3");
        db.upsert_track(&track).unwrap();
        db.create_playlist(&Playlist {
            id: "offline-playlist".to_string(),
            name: "Keep me".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        db.add_tracks_to_playlist("offline-playlist", &[track.id.clone()])
            .unwrap();
        db.record_play(&track.id).unwrap();
        db.save_track_eq_override(&TrackEqOverride {
            track_id: track.id.clone(),
            enabled: true,
            preamp_db: -2.0,
            gains: vec![0.0; 10],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        })
        .unwrap();

        let unavailable =
            std::env::temp_dir().join(format!("viby-offline-{}", uuid::Uuid::new_v4()));
        assert!(crate::library::scanner::scan_directory(unavailable.to_str().unwrap()).is_err());
        assert_eq!(
            db.remove_missing_tracks_from_scanned_roots(&[], &[])
                .unwrap(),
            0
        );
        assert_eq!(
            db.remove_missing_tracks_from_scanned_roots(
                &[("/offline/music".to_string(), Vec::new())],
                &[],
            )
            .unwrap(),
            0
        );

        assert!(db.get_track(&track.id).unwrap().is_some());
        assert_eq!(db.get_playlist_tracks("offline-playlist").unwrap().len(), 1);
        assert_eq!(db.get_recently_played(10).unwrap().len(), 1);
        assert!(db.get_track_eq_override(&track.id).unwrap().is_some());
    }

    #[test]
    fn pruning_is_transactional_when_one_delete_fails() {
        let db = open_in_memory();
        db.upsert_track(&sample_track("first", "/music/first.mp3"))
            .unwrap();
        db.upsert_track(&sample_track("second", "/music/second.mp3"))
            .unwrap();
        db.writer()
            .execute_batch(
                "CREATE TRIGGER reject_second_track_delete
                 BEFORE DELETE ON tracks WHEN OLD.id='second'
                 BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;",
            )
            .unwrap();

        assert!(
            db.remove_missing_tracks_from_scanned_roots(
                &[("/music".to_string(), vec!["/music/present.mp3".to_string()])],
                &[],
            )
            .is_err()
        );
        assert!(db.get_track("first").unwrap().is_some());
        assert!(db.get_track("second").unwrap().is_some());
    }

    #[test]
    fn search_tracks_fts_returns_matches() {
        let db = open_in_memory();
        let mut t = sample_track("s1", "/music/needle.mp3");
        t.title = "Needle In A Haystack".to_string();
        db.upsert_track(&t).unwrap();
        db.upsert_track(&sample_track("s2", "/music/other.mp3"))
            .unwrap();

        let results = db.search_tracks("needle").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "s1");
    }

    #[test]
    fn search_tracks_multi_token_requires_all_tokens() {
        let db = open_in_memory();
        let mut t = sample_track("m1", "/music/m1.mp3");
        t.title = "Love Story".to_string();
        t.artist = "Taylor Swift".to_string();
        db.upsert_track(&t).unwrap();

        // Both tokens present → match
        assert_eq!(db.search_tracks("love taylor").unwrap().len(), 1);
        // Only one token present → no match (artist matches but title doesn't have "xyz")
        assert_eq!(db.search_tracks("love xyz").unwrap().len(), 0);
    }
}

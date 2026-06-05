// =============================================================================
// library/database.rs — SQLite database operations
// =============================================================================
//
// This module handles all database interactions using rusqlite (SQLite).
// Think of it like a "repository" or "data access layer" in backend patterns.
//
// The database stores:
//   - tracks: every audio file that's been scanned and indexed
//   - playlists: user-created playlists
//   - playlist_tracks: many-to-many relationship between playlists and tracks
//   - library_folders: directories the user has added to scan
//
// Key Rust concepts:
//   - `rusqlite::Connection` → like a database client connection
//   - `params![]` → macro to safely bind parameters (prevents SQL injection)
//   - `query_map` → like a SELECT that maps each row to a Rust struct
//   - `execute` → like a non-SELECT statement (INSERT, UPDATE, DELETE)
// =============================================================================

use rusqlite::{params, Connection, Result as SqlResult};

use crate::models::{Album, Artist, Playlist, Track};

// =============================================================================
// Database — the main database wrapper
// =============================================================================

/// Wrapper around a SQLite connection.
/// All database operations are methods on this struct.
pub struct Database {
    /// The SQLite connection.
    /// In Rust, this is an owned connection — when Database is dropped,
    /// the connection is automatically closed.
    conn: Connection,
}

impl Database {
    /// Open (or create) the database at the given file path.
    ///
    /// # Arguments
    /// * `db_path` — path to the SQLite database file.
    ///   If the file doesn't exist, SQLite will create it.
    ///
    /// # Returns
    /// * `Ok(Database)` — successfully opened
    /// * `Err(...)` — couldn't open the file (permissions, disk full, etc.)
    pub fn open(db_path: &str) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;

        // Enable WAL mode for better concurrent read/write performance.
        // WAL = Write-Ahead Logging — like a transaction journal.
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        // Enable foreign key enforcement (SQLite has them disabled by default!)
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        Ok(Database { conn })
    }

    /// Initialize the database schema — create all tables if they don't exist.
    /// This is safe to call multiple times (uses IF NOT EXISTS).
    pub fn init_tables(&self) -> SqlResult<()> {
        self.conn.execute_batch(
            "
            -- Tracks table: stores metadata for each audio file
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

            -- Index on file_path for fast lookups during scanning
            CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);

            -- Index on artist for browsing by artist
            CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

            -- Index on album for browsing by album
            CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);

            -- Playlists table
            CREATE TABLE IF NOT EXISTS playlists (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            -- Playlist tracks: junction table linking playlists to tracks
            CREATE TABLE IF NOT EXISTS playlist_tracks (
                id          TEXT PRIMARY KEY,
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                position    INTEGER NOT NULL
            );

            -- Library folders: directories the user has added for scanning
            CREATE TABLE IF NOT EXISTS library_folders (
                id   TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE
            );
            ",
        )?;

        Ok(())
    }

    // =========================================================================
    // Track operations
    // =========================================================================

    /// Insert or update a track in the database.
    /// Uses INSERT OR REPLACE — if a track with the same file_path exists,
    /// it will be updated instead of duplicated.
    pub fn upsert_track(&self, track: &Track) -> SqlResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO tracks
             (id, title, artist, album, album_artist, genre, year, track_number,
              disc_number, duration_secs, file_path, file_size, date_added)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                track.date_added,
            ],
        )?;
        Ok(())
    }

    /// Get a single track by its ID.
    pub fn get_track(&self, id: &str) -> SqlResult<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map(params![id], |row| Self::row_to_track(row))?;
        match rows.next() {
            Some(result) => Ok(Some(result?)),
            None => Ok(None),
        }
    }

    /// Get a single track by its file path.
    pub fn get_track_by_path(&self, file_path: &str) -> SqlResult<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks WHERE file_path = ?1",
        )?;

        let mut rows = stmt.query_map(params![file_path], |row| Self::row_to_track(row))?;
        match rows.next() {
            Some(result) => Ok(Some(result?)),
            None => Ok(None),
        }
    }

    /// Get all tracks in the library, sorted by artist → album → track_number.
    pub fn get_all_tracks(&self) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_number, track_number",
        )?;

        let tracks = stmt
            .query_map([], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tracks)
    }

    /// Get all tracks belonging to a specific album.
    pub fn get_tracks_by_album(&self, album: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks WHERE album = ?1
             ORDER BY disc_number, track_number",
        )?;

        let tracks = stmt
            .query_map(params![album], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tracks)
    }

    /// Get all tracks by a specific artist.
    pub fn get_tracks_by_artist(&self, artist: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks WHERE artist = ?1
             ORDER BY album COLLATE NOCASE, disc_number, track_number",
        )?;

        let tracks = stmt
            .query_map(params![artist], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tracks)
    }

    /// Search for tracks matching a query string.
    /// Searches across title, artist, and album fields using SQL LIKE.
    pub fn search_tracks(&self, query: &str) -> SqlResult<Vec<Track>> {
        let like_pattern = format!("%{}%", query);
        let mut stmt = self.conn.prepare(
            "SELECT id, title, artist, album, album_artist, genre, year, track_number,
                    disc_number, duration_secs, file_path, file_size, date_added
             FROM tracks
             WHERE title LIKE ?1 COLLATE NOCASE
                OR artist LIKE ?1 COLLATE NOCASE
                OR album LIKE ?1 COLLATE NOCASE
             ORDER BY title COLLATE NOCASE
             LIMIT 100",
        )?;

        let tracks = stmt
            .query_map(params![like_pattern], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tracks)
    }

    /// Delete a track by its ID.
    pub fn delete_track(&self, id: &str) -> SqlResult<()> {
        self.conn
            .execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete tracks whose files no longer exist on disk.
    /// Returns the number of tracks removed.
    pub fn remove_missing_tracks(&self) -> SqlResult<usize> {
        let all_tracks = self.get_all_tracks()?;
        let mut removed = 0;

        for track in &all_tracks {
            if !std::path::Path::new(&track.file_path).exists() {
                self.delete_track(&track.id)?;
                removed += 1;
            }
        }

        Ok(removed)
    }

    // =========================================================================
    // Album & Artist aggregation
    // =========================================================================

    /// Get all albums, aggregated from track data.
    pub fn get_albums(&self) -> SqlResult<Vec<Album>> {
        let mut stmt = self.conn.prepare(
            "SELECT album, album_artist, year, COUNT(*) as track_count, MIN(id) as first_track_id
             FROM tracks
             GROUP BY album, album_artist
             ORDER BY album_artist COLLATE NOCASE, year, album COLLATE NOCASE",
        )?;

        let albums = stmt
            .query_map([], |row| {
                Ok(Album {
                    name: row.get(0)?,
                    artist: row.get(1)?,
                    year: row.get(2)?,
                    track_count: row.get(3)?,
                    artwork_track_id: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(albums)
    }

    /// Get all artists, aggregated from track data.
    pub fn get_artists(&self) -> SqlResult<Vec<Artist>> {
        let mut stmt = self.conn.prepare(
            "SELECT artist,
                    COUNT(DISTINCT album) as album_count,
                    COUNT(*) as track_count
             FROM tracks
             GROUP BY artist
             ORDER BY artist COLLATE NOCASE",
        )?;

        let artists = stmt
            .query_map([], |row| {
                Ok(Artist {
                    name: row.get(0)?,
                    album_count: row.get(1)?,
                    track_count: row.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(artists)
    }

    /// Get all unique genre names.
    pub fn get_genres(&self) -> SqlResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT genre FROM tracks
             WHERE genre != 'Unknown'
             ORDER BY genre COLLATE NOCASE",
        )?;

        let genres = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(genres)
    }

    // =========================================================================
    // Playlist operations
    // =========================================================================

    /// Create a new playlist.
    pub fn create_playlist(&self, playlist: &Playlist) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                playlist.id,
                playlist.name,
                playlist.created_at,
                playlist.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Get all playlists with their track counts.
    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.name, p.created_at, p.updated_at,
                    COUNT(pt.id) as track_count
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
             GROUP BY p.id
             ORDER BY p.name COLLATE NOCASE",
        )?;

        let playlists = stmt
            .query_map([], |row| {
                Ok(Playlist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    track_count: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(playlists)
    }

    /// Delete a playlist by ID. Cascade will remove playlist_tracks entries.
    pub fn delete_playlist(&self, id: &str) -> SqlResult<()> {
        self.conn
            .execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Rename a playlist.
    pub fn rename_playlist(&self, id: &str, new_name: &str) -> SqlResult<()> {
        let now = chrono_now();
        self.conn.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_name, now, id],
        )?;
        Ok(())
    }

    /// Get all tracks in a playlist, ordered by position.
    pub fn get_playlist_tracks(&self, playlist_id: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.genre,
                    t.year, t.track_number, t.disc_number, t.duration_secs,
                    t.file_path, t.file_size, t.date_added
             FROM tracks t
             INNER JOIN playlist_tracks pt ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position",
        )?;

        let tracks = stmt
            .query_map(params![playlist_id], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tracks)
    }

    /// Add tracks to a playlist.
    pub fn add_tracks_to_playlist(
        &self,
        playlist_id: &str,
        track_ids: &[String],
    ) -> SqlResult<()> {
        // Get the current max position in this playlist
        let max_pos: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);

        let mut position = max_pos + 1;

        for track_id in track_ids {
            let pt_id = uuid::Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO playlist_tracks (id, playlist_id, track_id, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![pt_id, playlist_id, track_id, position],
            )?;
            position += 1;
        }

        // Update the playlist's updated_at timestamp
        let now = chrono_now();
        self.conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        Ok(())
    }

    /// Remove a track from a playlist.
    pub fn remove_track_from_playlist(
        &self,
        playlist_id: &str,
        track_id: &str,
    ) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM playlist_tracks
             WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;

        // Update the playlist's updated_at timestamp
        let now = chrono_now();
        self.conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        Ok(())
    }

    /// Reorder tracks in a playlist based on a new ordering of track IDs.
    pub fn reorder_playlist(
        &self,
        playlist_id: &str,
        track_ids: &[String],
    ) -> SqlResult<()> {
        for (position, track_id) in track_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlist_tracks SET position = ?1
                 WHERE playlist_id = ?2 AND track_id = ?3",
                params![position as i64, playlist_id, track_id],
            )?;
        }

        let now = chrono_now();
        self.conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;

        Ok(())
    }

    // =========================================================================
    // Library folder operations
    // =========================================================================

    /// Add a folder to the library.
    pub fn add_library_folder(&self, path: &str) -> SqlResult<()> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT OR IGNORE INTO library_folders (id, path) VALUES (?1, ?2)",
            params![id, path],
        )?;
        Ok(())
    }

    /// Remove a folder from the library.
    pub fn remove_library_folder(&self, path: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM library_folders WHERE path = ?1",
            params![path],
        )?;
        Ok(())
    }

    /// Get all library folder paths.
    pub fn get_library_folders(&self) -> SqlResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM library_folders ORDER BY path")?;

        let folders = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(folders)
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /// Convert a database row into a Track struct.
    /// This is a helper used by all query methods to avoid code duplication.
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
            date_added: row.get(12)?,
        })
    }
}

// =============================================================================
// Helper: get current timestamp in ISO 8601 format
// =============================================================================

/// Get the current UTC time as an ISO 8601 string.
/// We build this manually to avoid adding the chrono crate as a dependency.
fn chrono_now() -> String {
    // std::time::SystemTime gives us the current time, then we format it.
    // This produces a format like "2024-01-15T10:30:00Z"
    let now = std::time::SystemTime::now();
    let since_epoch = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs();

    // Convert seconds since epoch to date-time components.
    // This is a simplified algorithm (not handling leap seconds, etc.)
    // but more than adequate for timestamps.
    let days = secs / 86400;
    let time_of_day = secs % 86400;

    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year, month, day from days since epoch (1970-01-01)
    let (year, month, day) = days_to_date(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day).
/// Simple civil calendar calculation.
fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm based on Howard Hinnant's civil_from_days
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

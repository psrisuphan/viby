use rusqlite::{params, Connection, Result as SqlResult};

use crate::models::{Album, Artist, Playlist, TopArtist, Track};

const _CURRENT_SCHEMA_VERSION: u32 = 3;

// =============================================================================
// Database
// =============================================================================

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open (or create) the database and run all pending migrations.
    pub fn open(db_path: &str) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        run_migrations(&conn)?;
        Ok(Database { conn })
    }

    // =========================================================================
    // Track operations
    // =========================================================================

    pub fn upsert_track(&self, track: &Track) -> SqlResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO tracks
             (id, title, artist, album, album_artist, genre, year, track_number,
              disc_number, duration_secs, file_path, file_size, date_added)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                track.id, track.title, track.artist, track.album,
                track.album_artist, track.genre, track.year, track.track_number,
                track.disc_number, track.duration_secs, track.file_path,
                track.file_size, track.date_added,
            ],
        )?;
        Ok(())
    }

    /// Insert a batch of tracks inside a single transaction — much faster than
    /// calling `upsert_track` in a loop for large libraries.
    pub fn upsert_tracks_batch(&self, tracks: &[Track]) -> SqlResult<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        for track in tracks {
            if let Err(e) = self.upsert_track(track) {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }

    pub fn get_all_file_paths(&self) -> SqlResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT file_path FROM tracks")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_track(&self, id: &str) -> SqlResult<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks WHERE id=?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| Self::row_to_track(row))?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn get_track_by_path(&self, file_path: &str) -> SqlResult<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks WHERE file_path=?1",
        )?;
        let mut rows = stmt.query_map(params![file_path], |row| Self::row_to_track(row))?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn get_all_tracks(&self) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks
             ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_number, track_number",
        )?;
        Ok(stmt
            .query_map([], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_tracks_by_album(&self, album: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks WHERE album=?1
             ORDER BY disc_number, track_number",
        )?;
        Ok(stmt
            .query_map(params![album], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_tracks_by_album_and_artist(&self, album: &str, album_artist: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks WHERE album=?1 AND album_artist=?2
             ORDER BY disc_number, track_number",
        )?;
        Ok(stmt
            .query_map(params![album, album_artist], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_tracks_by_artist(&self, artist: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks WHERE artist=?1
             ORDER BY album COLLATE NOCASE, disc_number, track_number",
        )?;
        Ok(stmt
            .query_map(params![artist], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    /// Full-text search using the FTS5 index. Each whitespace-separated token
    /// must prefix-match at least one of: title, artist, album, album_artist, genre.
    pub fn search_tracks(&self, query: &str) -> SqlResult<Vec<Track>> {
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.genre,
                    t.year, t.track_number, t.disc_number, t.duration_secs,
                    t.file_path, t.file_size, t.date_added
             FROM tracks t
             JOIN tracks_fts ON t.rowid = tracks_fts.rowid
             WHERE tracks_fts MATCH ?1
             ORDER BY rank
             LIMIT 200",
        )?;
        Ok(stmt
            .query_map(params![fts_query], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn delete_track(&self, id: &str) -> SqlResult<()> {
        self.conn.execute("DELETE FROM tracks WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn get_all_track_paths(&self) -> SqlResult<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT id, file_path FROM tracks")?;
        Ok(stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect())
    }

    /// Delete tracks whose files no longer exist, then clean up any dangling
    /// playlist_tracks rows that reference deleted track IDs.
    pub fn remove_missing_tracks(&self) -> SqlResult<usize> {
        let track_paths = self.get_all_track_paths()?;
        let mut removed = 0;
        for (id, file_path) in &track_paths {
            if !std::path::Path::new(file_path).exists() {
                self.delete_track(id)?;
                removed += 1;
            }
        }
        // Remove playlist entries whose track was just deleted.
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE track_id NOT IN (SELECT id FROM tracks)",
            [],
        )?;
        Ok(removed)
    }

    // =========================================================================
    // Album & Artist aggregation
    // =========================================================================

    pub fn get_albums(&self) -> SqlResult<Vec<Album>> {
        let mut stmt = self.conn.prepare(
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
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_artists(&self) -> SqlResult<Vec<Artist>> {
        let mut stmt = self.conn.prepare(
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
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn get_genres(&self) -> SqlResult<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT genre FROM tracks
             WHERE genre != 'Unknown'
             ORDER BY genre COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect())
    }

    // =========================================================================
    // Playlist operations
    // =========================================================================

    pub fn create_playlist(&self, playlist: &Playlist) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1,?2,?3,?4)",
            params![playlist.id, playlist.name, playlist.created_at, playlist.updated_at],
        )?;
        Ok(())
    }

    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let mut stmt = self.conn.prepare(
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
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn delete_playlist(&self, id: &str) -> SqlResult<()> {
        self.conn.execute("DELETE FROM playlists WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn rename_playlist(&self, id: &str, new_name: &str) -> SqlResult<()> {
        let now = crate::utils::current_timestamp();
        self.conn.execute(
            "UPDATE playlists SET name=?1, updated_at=?2 WHERE id=?3",
            params![new_name, now, id],
        )?;
        Ok(())
    }

    pub fn get_playlist_tracks(&self, playlist_id: &str) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id,t.title,t.artist,t.album,t.album_artist,t.genre,
                    t.year,t.track_number,t.disc_number,t.duration_secs,
                    t.file_path,t.file_size,t.date_added
             FROM tracks t
             INNER JOIN playlist_tracks pt ON t.id = pt.track_id
             WHERE pt.playlist_id=?1
             ORDER BY pt.position",
        )?;
        Ok(stmt
            .query_map(params![playlist_id], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    pub fn add_tracks_to_playlist(&self, playlist_id: &str, track_ids: &[String]) -> SqlResult<()> {
        let max_pos: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id=?1",
                params![playlist_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        let mut position = max_pos + 1;
        for track_id in track_ids {
            let pt_id = uuid::Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO playlist_tracks (id, playlist_id, track_id, position)
                 VALUES (?1,?2,?3,?4)",
                params![pt_id, playlist_id, track_id, position],
            )?;
            position += 1;
        }
        let now = crate::utils::current_timestamp();
        self.conn.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        Ok(())
    }

    pub fn remove_track_from_playlist(&self, playlist_id: &str, track_id: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id=?1 AND track_id=?2",
            params![playlist_id, track_id],
        )?;
        let now = crate::utils::current_timestamp();
        self.conn.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        Ok(())
    }

    pub fn reorder_playlist(&self, playlist_id: &str, track_ids: &[String]) -> SqlResult<()> {
        for (position, track_id) in track_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE playlist_tracks SET position=?1 WHERE playlist_id=?2 AND track_id=?3",
                params![position as i64, playlist_id, track_id],
            )?;
        }
        let now = crate::utils::current_timestamp();
        self.conn.execute(
            "UPDATE playlists SET updated_at=?1 WHERE id=?2",
            params![now, playlist_id],
        )?;
        Ok(())
    }

    // =========================================================================
    // Library folder operations
    // =========================================================================

    pub fn add_library_folder(&self, path: &str) -> SqlResult<()> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT OR IGNORE INTO library_folders (id, path) VALUES (?1,?2)",
            params![id, path],
        )?;
        Ok(())
    }

    pub fn remove_library_folder(&self, path: &str) -> SqlResult<()> {
        let prefix = format!("{}%", path);
        self.conn.execute("DELETE FROM tracks WHERE file_path LIKE ?1", params![prefix])?;
        self.conn.execute("DELETE FROM library_folders WHERE path=?1", params![path])?;
        Ok(())
    }

    pub fn get_library_folders(&self) -> SqlResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT path FROM library_folders ORDER BY path")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect())
    }

    // =========================================================================
    // Play history
    // =========================================================================

    pub fn record_play(&self, track_id: &str) -> SqlResult<()> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let played_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO play_history (track_id, played_at) VALUES (?1, ?2)",
            params![track_id, played_at],
        )?;
        // Keep only the most recent 5,000 rows to prevent unbounded growth.
        self.conn.execute(
            "DELETE FROM play_history WHERE id NOT IN (
                 SELECT id FROM play_history ORDER BY played_at DESC LIMIT 5000
             )",
            [],
        )?;
        Ok(())
    }

    pub fn clear_play_history(&self) -> SqlResult<()> {
        self.conn.execute("DELETE FROM play_history", [])?;
        Ok(())
    }

    /// Return the N most recently played distinct tracks (one entry per track).
    pub fn get_recently_played(&self, limit: usize) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id,t.title,t.artist,t.album,t.album_artist,t.genre,
                    t.year,t.track_number,t.disc_number,t.duration_secs,
                    t.file_path,t.file_size,t.date_added
             FROM tracks t
             INNER JOIN play_history ph ON t.id = ph.track_id
             GROUP BY t.id
             ORDER BY MAX(ph.played_at) DESC
             LIMIT ?1",
        )?;
        Ok(stmt
            .query_map(params![limit as i64], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
    }

    /// Return the N artists with the most plays, with a sample track ID for artwork.
    pub fn get_top_artists_played(&self, limit: usize) -> SqlResult<Vec<TopArtist>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.artist, COUNT(*) as play_count, MIN(t.id) as artwork_track_id
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
                })
            })?
            .filter_map(|r| r.ok())
            .collect())
    }

    /// Return the N most recently added tracks (by date_added).
    pub fn get_recently_added_tracks(&self, limit: usize) -> SqlResult<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,title,artist,album,album_artist,genre,year,track_number,
                    disc_number,duration_secs,file_path,file_size,date_added
             FROM tracks
             ORDER BY date_added DESC
             LIMIT ?1",
        )?;
        Ok(stmt
            .query_map(params![limit as i64], |row| Self::row_to_track(row))?
            .filter_map(|r| r.ok())
            .collect())
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
            date_added: row.get(12)?,
        })
    }
}

// =============================================================================
// Migration framework
// =============================================================================

fn schema_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0)
}

fn set_schema_version(conn: &Connection, version: u32) {
    let _ = conn.execute_batch(&format!("PRAGMA user_version = {version}"));
}

/// Run all pending migrations in order. Each block is idempotent — it only runs
/// if the stored schema version is below the block's target version.
fn run_migrations(conn: &Connection) -> SqlResult<()> {
    let version = schema_version(conn);

    if version < 1 {
        conn.execute_batch(
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
        )?;
        set_schema_version(conn, 1);
    }

    if version < 2 {
        // FTS5 content table mirrors title/artist/album/album_artist/genre for fast full-text search.
        // Triggers keep it in sync with the tracks table automatically.
        conn.execute_batch(
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
        )?;
        set_schema_version(conn, 2);
    }

    if version < 3 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS play_history (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                track_id  TEXT    NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                played_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);
            CREATE INDEX IF NOT EXISTS idx_play_history_track_id  ON play_history(track_id);
            ",
        )?;
        set_schema_version(conn, 3);
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
        Database { conn }
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
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn upsert_is_idempotent() {
        let db = open_in_memory();
        let t = sample_track("abc", "/music/a.mp3");
        db.upsert_track(&t).unwrap();
        db.upsert_track(&t).unwrap(); // second insert = replace
        let all = db.get_all_tracks().unwrap();
        assert_eq!(all.len(), 1, "Duplicate upsert should result in exactly 1 row");
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
    fn remove_missing_tracks_cleans_playlist_entries() {
        let db = open_in_memory();

        // Insert track pointing at a non-existent path
        let t = sample_track("t1", "/nonexistent/ghost.mp3");
        db.upsert_track(&t).unwrap();

        // Create a playlist and add the track to it
        use crate::models::Playlist;
        let pl = Playlist {
            id: "pl1".to_string(),
            name: "Test".to_string(),
            track_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        db.create_playlist(&pl).unwrap();
        db.add_tracks_to_playlist("pl1", &["t1".to_string()]).unwrap();

        // Verify track is in playlist
        let before = db.get_playlist_tracks("pl1").unwrap();
        assert_eq!(before.len(), 1);

        // Run missing-track cleanup — ghost.mp3 doesn't exist
        let removed = db.remove_missing_tracks().unwrap();
        assert_eq!(removed, 1);

        // Playlist entry should also be gone
        let after = db.get_playlist_tracks("pl1").unwrap();
        assert_eq!(after.len(), 0, "Orphaned playlist entry should be removed");
    }

    #[test]
    fn search_tracks_fts_returns_matches() {
        let db = open_in_memory();
        let mut t = sample_track("s1", "/music/needle.mp3");
        t.title = "Needle In A Haystack".to_string();
        db.upsert_track(&t).unwrap();
        db.upsert_track(&sample_track("s2", "/music/other.mp3")).unwrap();

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

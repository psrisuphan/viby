use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Mutex, PoisonError};
#[cfg(test)]
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::database::Database;

const PLAY_HISTORY_QUEUE_CAPACITY: usize = 4096;

struct PlayHistoryEntry {
    track_id: String,
    context: String,
    played_at: i64,
}

enum PlayHistoryCommand {
    Record(PlayHistoryEntry),
    Clear(SyncSender<Result<(), String>>),
    #[cfg(test)]
    Flush(SyncSender<()>),
}

/// Serializes playback history writes away from command and audio threads.
/// Accepted entries retain FIFO order; a saturated queue is reported to the
/// caller instead of blocking playback while a scan owns the DB writer.
pub struct PlayHistoryWriter {
    sender: Mutex<Option<SyncSender<PlayHistoryCommand>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayHistoryQueueError {
    Full,
    Disconnected,
}

impl std::fmt::Display for PlayHistoryQueueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full => formatter.write_str("play history queue is full"),
            Self::Disconnected => formatter.write_str("play history writer has stopped"),
        }
    }
}

impl PlayHistoryWriter {
    pub fn new(database: Database) -> std::io::Result<Self> {
        Self::with_capacity(database, PLAY_HISTORY_QUEUE_CAPACITY)
    }

    fn with_capacity(database: Database, capacity: usize) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let worker = std::thread::Builder::new()
            .name("viby-play-history".into())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        PlayHistoryCommand::Record(entry) => {
                            if let Err(error) =
                                database.record_play_at(&entry.track_id, entry.played_at)
                            {
                                eprintln!(
                                    "[PlayHistory] Failed to record {} from {}: {error}",
                                    entry.track_id, entry.context
                                );
                            }
                        }
                        PlayHistoryCommand::Clear(acknowledgement) => {
                            let result = database
                                .clear_play_history()
                                .map_err(|error| error.to_string());
                            let _ = acknowledgement.send(result);
                        }
                        #[cfg(test)]
                        PlayHistoryCommand::Flush(acknowledgement) => {
                            let _ = acknowledgement.send(());
                        }
                    }
                }
            })?;

        Ok(Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Queue one history row without waiting for the SQLite writer lock.
    pub fn try_record_play(
        &self,
        track_id: &str,
        context: &str,
    ) -> Result<(), PlayHistoryQueueError> {
        self.try_record_play_at(
            track_id,
            context,
            crate::utils::current_unix_timestamp_seconds(),
        )
    }

    fn try_record_play_at(
        &self,
        track_id: &str,
        context: &str,
        played_at: i64,
    ) -> Result<(), PlayHistoryQueueError> {
        let entry = PlayHistoryEntry {
            track_id: track_id.to_string(),
            context: context.to_string(),
            played_at,
        };
        self.sender()
            .map_err(|_| PlayHistoryQueueError::Disconnected)?
            .try_send(PlayHistoryCommand::Record(entry))
            .map_err(|error| match error {
                TrySendError::Full(_) => PlayHistoryQueueError::Full,
                TrySendError::Disconnected(_) => PlayHistoryQueueError::Disconnected,
            })
    }

    fn sender(&self) -> Result<SyncSender<PlayHistoryCommand>, String> {
        self.sender
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .cloned()
            .ok_or_else(|| "play history writer has stopped".to_string())
    }

    /// Clear history in the same FIFO as plays and wait until the clear commits.
    pub fn clear_history(&self) -> Result<(), String> {
        self.enqueue_clear()?
            .recv()
            .map_err(|_| "play history writer stopped before clear completed".to_string())?
    }

    fn enqueue_clear(&self) -> Result<Receiver<Result<(), String>>, String> {
        let (acknowledgement, received) = mpsc::sync_channel(0);
        self.sender()?
            .send(PlayHistoryCommand::Clear(acknowledgement))
            .map_err(|_| "play history writer has stopped".to_string())?;
        Ok(received)
    }

    /// Close the queue and join its worker after every accepted entry is handled.
    pub fn shutdown(&self) {
        self.sender
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            && worker.join().is_err()
        {
            eprintln!("[PlayHistory] Writer thread panicked during shutdown");
        }
    }

    #[cfg(test)]
    pub(crate) fn flush_for_test(&self) {
        let (acknowledgement, received) = mpsc::sync_channel(0);
        self.sender()
            .expect("play history writer stopped before flush")
            .send(PlayHistoryCommand::Flush(acknowledgement))
            .expect("play history worker stopped before flush");
        received
            .recv_timeout(Duration::from_secs(2))
            .expect("play history worker did not flush in time");
    }
}

impl Drop for PlayHistoryWriter {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Best-effort enqueue used by playback transitions. Failures are logged and
/// never hold up playback; successful writes are serialized by the worker.
pub(crate) fn queue_play_history(app: &AppHandle, track_id: &str, context: &str) {
    let Some(writer) = app.try_state::<PlayHistoryWriter>() else {
        eprintln!("[PlayHistory] Writer unavailable for {track_id} from {context}");
        return;
    };
    if let Err(error) = writer.try_record_play(track_id, context) {
        eprintln!("[PlayHistory] Could not enqueue {track_id} from {context}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Track;

    fn sample_track(id: &str) -> Track {
        Track {
            id: id.to_string(),
            title: format!("Track {id}"),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Rock".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 200.0,
            file_path: format!("/library/{id}.flac"),
            file_size: 2048,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn queued_history_preserves_order_duplicates_and_enqueue_timestamps() {
        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("a")).unwrap();
        database.upsert_track(&sample_track("b")).unwrap();
        let writer = PlayHistoryWriter::new(database.clone()).unwrap();

        writer.try_record_play_at("a", "test", 101).unwrap();
        writer.try_record_play_at("b", "test", 202).unwrap();
        writer.try_record_play_at("a", "test", 303).unwrap();
        writer.flush_for_test();

        assert_eq!(
            database.play_history_entries_for_test().unwrap(),
            [
                ("a".to_string(), 101),
                ("b".to_string(), 202),
                ("a".to_string(), 303)
            ]
        );
    }

    #[test]
    fn bounded_queue_reports_saturation_without_waiting_for_worker() {
        use std::sync::mpsc;
        use std::time::Instant;

        let database = Database::open(":memory:").expect("in-memory database");
        let track = sample_track("queued");
        database.upsert_track(&track).unwrap();
        let writer = PlayHistoryWriter::with_capacity(database.clone(), 0).unwrap();
        let (locked, locked_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let lock_database = database.clone();
        let lock_thread = std::thread::spawn(move || {
            lock_database.with_writer_lock_for_test(|| {
                locked.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if writer.try_record_play("queued", "test").is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker did not receive test item"
            );
            std::thread::yield_now();
        }
        assert_eq!(
            writer.try_record_play("queued", "test"),
            Err(PlayHistoryQueueError::Full)
        );

        release.send(()).unwrap();
        lock_thread.join().unwrap();
        writer.flush_for_test();
        assert_eq!(
            database.play_history_track_ids_for_test().unwrap(),
            ["queued"]
        );
        writer.shutdown();
    }

    #[test]
    fn shutdown_drains_accepted_history_before_returning() {
        use std::sync::{Arc, mpsc};

        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("queued")).unwrap();
        let writer = Arc::new(PlayHistoryWriter::with_capacity(database.clone(), 1).unwrap());

        let (locked, locked_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let lock_database = database.clone();
        let lock_thread = std::thread::spawn(move || {
            lock_database.with_writer_lock_for_test(|| {
                locked.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        writer.try_record_play_at("queued", "test", 456).unwrap();
        let (shutdown_done, shutdown_done_rx) = mpsc::channel();
        let shutdown_writer = Arc::clone(&writer);
        let shutdown_thread = std::thread::spawn(move || {
            shutdown_writer.shutdown();
            shutdown_done.send(()).unwrap();
        });
        assert!(shutdown_done_rx.try_recv().is_err());

        release.send(()).unwrap();
        lock_thread.join().unwrap();
        shutdown_thread.join().unwrap();
        shutdown_done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("shutdown did not join the history worker");

        assert_eq!(
            database.play_history_entries_for_test().unwrap(),
            [("queued".to_string(), 456)]
        );
    }

    #[test]
    fn playback_timestamp_is_captured_before_a_delayed_database_write() {
        use std::sync::mpsc;
        use std::time::Instant;

        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("queued")).unwrap();
        let writer = PlayHistoryWriter::with_capacity(database.clone(), 1).unwrap();

        let (locked, locked_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let lock_database = database.clone();
        let lock_thread = std::thread::spawn(move || {
            lock_database.with_writer_lock_for_test(|| {
                locked.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let earliest_timestamp = crate::utils::current_unix_timestamp_seconds();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if writer.try_record_play("queued", "test").is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker did not receive test item"
            );
            std::thread::yield_now();
        }
        let latest_enqueue_timestamp = crate::utils::current_unix_timestamp_seconds();

        let clock_deadline = Instant::now() + Duration::from_secs(3);
        while crate::utils::current_unix_timestamp_seconds() <= latest_enqueue_timestamp {
            assert!(
                Instant::now() < clock_deadline,
                "system clock did not advance"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        release.send(()).unwrap();
        lock_thread.join().unwrap();
        writer.flush_for_test();
        let entries = database.play_history_entries_for_test().unwrap();
        assert_eq!(entries.len(), 1);
        assert!((earliest_timestamp..=latest_enqueue_timestamp).contains(&entries[0].1));
    }

    #[test]
    fn clear_history_is_ordered_between_queued_plays() {
        use std::sync::mpsc;

        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("before")).unwrap();
        database.upsert_track(&sample_track("after")).unwrap();
        let writer = PlayHistoryWriter::with_capacity(database.clone(), 3).unwrap();

        let (locked, locked_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let lock_database = database.clone();
        let lock_thread = std::thread::spawn(move || {
            lock_database.with_writer_lock_for_test(|| {
                locked.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        writer.try_record_play_at("before", "test", 100).unwrap();
        let clear_completed = writer.enqueue_clear().unwrap();
        writer.try_record_play_at("after", "test", 200).unwrap();

        release.send(()).unwrap();
        lock_thread.join().unwrap();
        clear_completed
            .recv_timeout(Duration::from_secs(2))
            .expect("clear command did not complete")
            .unwrap();
        writer.flush_for_test();

        assert_eq!(
            database.play_history_entries_for_test().unwrap(),
            [("after".to_string(), 200)]
        );
    }

    #[test]
    fn a_blocked_clear_does_not_block_playback_history_enqueues() {
        use std::sync::{Arc, mpsc};
        use std::time::Instant;

        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("track")).unwrap();
        let writer = Arc::new(PlayHistoryWriter::with_capacity(database.clone(), 0).unwrap());

        let (locked, locked_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let lock_database = database.clone();
        let lock_thread = std::thread::spawn(move || {
            lock_database.with_writer_lock_for_test(|| {
                locked.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if writer
                .try_record_play_at("track", "before-clear", 100)
                .is_ok()
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker did not receive test item"
            );
            std::thread::yield_now();
        }

        let (clear_started, clear_started_rx) = mpsc::channel();
        let (clear_done, clear_done_rx) = mpsc::channel();
        let clear_writer = Arc::clone(&writer);
        let clear_thread = std::thread::spawn(move || {
            clear_started.send(()).unwrap();
            clear_done.send(clear_writer.clear_history()).unwrap();
        });
        clear_started_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();

        let producer_writer = Arc::clone(&writer);
        let (producer_done, producer_done_rx) = mpsc::channel();
        let producer_thread = std::thread::spawn(move || {
            producer_done
                .send(producer_writer.try_record_play_at("track", "after-clear", 200))
                .unwrap();
        });
        assert_eq!(
            producer_done_rx.recv_timeout(Duration::from_millis(100)),
            Ok(Err(PlayHistoryQueueError::Full)),
            "playback enqueue blocked behind the pending clear"
        );

        release.send(()).unwrap();
        lock_thread.join().unwrap();
        producer_thread.join().unwrap();
        clear_thread.join().unwrap();
        clear_done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("clear did not finish")
            .unwrap();
        writer.shutdown();

        assert!(database.play_history_entries_for_test().unwrap().is_empty());
    }
}

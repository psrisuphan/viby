use std::sync::mpsc::{self, SyncSender, TrySendError};
#[cfg(test)]
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::database::Database;

const PLAY_HISTORY_QUEUE_CAPACITY: usize = 4096;

struct PlayHistoryEntry {
    track_id: String,
    context: String,
}

enum PlayHistoryCommand {
    Record(PlayHistoryEntry),
    #[cfg(test)]
    Flush(SyncSender<()>),
    #[cfg(test)]
    Shutdown(SyncSender<()>),
}

/// Serializes playback history writes away from command and audio threads.
/// Accepted entries retain FIFO order; a saturated queue is reported to the
/// caller instead of blocking playback while a scan owns the DB writer.
pub struct PlayHistoryWriter {
    sender: SyncSender<PlayHistoryCommand>,
    #[cfg(test)]
    worker: Option<std::thread::JoinHandle<()>>,
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
    pub fn new(database: Database) -> Self {
        Self::with_capacity(database, PLAY_HISTORY_QUEUE_CAPACITY)
    }

    fn with_capacity(database: Database, capacity: usize) -> Self {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let worker = std::thread::Builder::new()
            .name("viby-play-history".into())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        PlayHistoryCommand::Record(entry) => {
                            if let Err(error) = database.record_play(&entry.track_id) {
                                eprintln!(
                                    "[PlayHistory] Failed to record {} from {}: {error}",
                                    entry.track_id, entry.context
                                );
                            }
                        }
                        #[cfg(test)]
                        PlayHistoryCommand::Flush(acknowledgement) => {
                            let _ = acknowledgement.send(());
                        }
                        #[cfg(test)]
                        PlayHistoryCommand::Shutdown(acknowledgement) => {
                            let _ = acknowledgement.send(());
                            break;
                        }
                    }
                }
            })
            .expect("failed to start play history writer thread");

        #[cfg(not(test))]
        drop(worker);
        Self {
            sender,
            #[cfg(test)]
            worker: Some(worker),
        }
    }

    /// Queue one history row without waiting for the SQLite writer lock.
    pub fn try_record_play(
        &self,
        track_id: &str,
        context: &str,
    ) -> Result<(), PlayHistoryQueueError> {
        let entry = PlayHistoryEntry {
            track_id: track_id.to_string(),
            context: context.to_string(),
        };
        self.sender
            .try_send(PlayHistoryCommand::Record(entry))
            .map_err(|error| match error {
                TrySendError::Full(_) => PlayHistoryQueueError::Full,
                TrySendError::Disconnected(_) => PlayHistoryQueueError::Disconnected,
            })
    }

    #[cfg(test)]
    pub(crate) fn flush_for_test(&self) {
        let (acknowledgement, received) = mpsc::sync_channel(0);
        self.sender
            .send(PlayHistoryCommand::Flush(acknowledgement))
            .expect("play history worker stopped before flush");
        received
            .recv_timeout(Duration::from_secs(2))
            .expect("play history worker did not flush in time");
    }

    #[cfg(test)]
    pub(crate) fn shutdown_for_test(mut self) {
        let (acknowledgement, received) = mpsc::sync_channel(0);
        self.sender
            .send(PlayHistoryCommand::Shutdown(acknowledgement))
            .expect("play history worker stopped before shutdown");
        received
            .recv_timeout(Duration::from_secs(2))
            .expect("play history worker did not shut down in time");
        self.worker
            .take()
            .expect("play history worker join handle is missing")
            .join()
            .expect("play history worker panicked");
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
    fn queued_history_preserves_order_and_duplicate_plays() {
        let database = Database::open(":memory:").expect("in-memory database");
        database.upsert_track(&sample_track("a")).unwrap();
        database.upsert_track(&sample_track("b")).unwrap();
        let writer = PlayHistoryWriter::new(database.clone());

        writer.try_record_play("a", "test").unwrap();
        writer.try_record_play("b", "test").unwrap();
        writer.try_record_play("a", "test").unwrap();
        writer.flush_for_test();

        assert_eq!(
            database.play_history_track_ids_for_test().unwrap(),
            ["a", "b", "a"]
        );
        writer.shutdown_for_test();
    }

    #[test]
    fn bounded_queue_reports_saturation_without_waiting_for_worker() {
        use std::sync::mpsc;
        use std::time::Instant;

        let database = Database::open(":memory:").expect("in-memory database");
        let track = sample_track("queued");
        database.upsert_track(&track).unwrap();
        let writer = PlayHistoryWriter::with_capacity(database.clone(), 0);
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
        writer.shutdown_for_test();
    }
}

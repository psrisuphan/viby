// =============================================================================
// audio/queue.rs — Playback queue management
// =============================================================================
//
// The playback queue is like a playlist that the player works through.
// It supports:
//   - Adding/removing tracks
//   - Next/previous navigation
//   - Shuffle (Fisher-Yates algorithm)
//   - Repeat modes (off, one, all)
//
// Key Rust concepts:
//   - `Vec<T>` → like JavaScript `Array<T>`
//   - `Option<usize>` → optional index (like `number | null` in TypeScript)
//   - `&self` vs `&mut self` → read-only vs mutable access
// =============================================================================

use crate::models::{RepeatMode, Track};

// =============================================================================
// PlaybackQueue — the queue data structure
// =============================================================================

/// Manages the list of tracks to play, including ordering and navigation.
///
/// When shuffle is OFF, tracks play in their natural order (as added).
/// When shuffle is ON, a separate shuffled index list determines the order,
/// so the original order is preserved and can be restored.
#[derive(Debug)]
pub struct PlaybackQueue {
    /// The actual list of tracks in their "natural" (user-added) order
    tracks: Vec<Track>,

    /// Current position in the play order.
    /// This indexes into `shuffle_indices` when shuffle is on,
    /// or directly into `tracks` when shuffle is off.
    current_index: Option<usize>,

    /// Shuffled order — a list of indices into `tracks`.
    /// Only used when shuffle mode is ON.
    /// Example: if tracks = [A, B, C, D] and shuffle_indices = [2, 0, 3, 1],
    /// then playback order is C, A, D, B.
    shuffle_indices: Vec<usize>,

    /// Whether shuffle mode is currently active
    shuffle: bool,

    /// Current repeat mode
    repeat_mode: RepeatMode,
}

impl PlaybackQueue {
    /// Create a new empty queue.
    pub fn new() -> Self {
        PlaybackQueue {
            tracks: Vec::new(),
            current_index: None,
            shuffle_indices: Vec::new(),
            shuffle: false,
            repeat_mode: RepeatMode::Off,
        }
    }

    // =========================================================================
    // Queue manipulation
    // =========================================================================

    /// Add a track to the end of the queue.
    pub fn add(&mut self, track: Track) {
        let new_index = self.tracks.len();
        self.tracks.push(track);

        // Add the new track's index to the shuffle list too
        self.shuffle_indices.push(new_index);

        // If this is the first track, set it as current
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
    }

    /// Add multiple tracks to the end of the queue.
    pub fn add_many(&mut self, tracks: Vec<Track>) {
        for track in tracks {
            self.add(track);
        }
    }

    /// Remove a track at the given index (in the natural order).
    /// Returns the removed track, or None if the index is out of bounds.
    pub fn remove(&mut self, index: usize) -> Option<Track> {
        if index >= self.tracks.len() {
            return None;
        }

        let removed = self.tracks.remove(index);

        // Rebuild shuffle indices since positions have shifted
        self.rebuild_shuffle_indices();

        // Adjust current index
        if let Some(current) = self.current_index {
            let effective_len = self.tracks.len();
            if effective_len == 0 {
                self.current_index = None;
            } else if index < current {
                // A track before current was removed — shift current back by 1
                self.current_index = Some(current - 1);
            } else if current >= effective_len {
                self.current_index = Some(effective_len - 1);
            }
        }

        Some(removed)
    }

    /// Clear the entire queue (completely empty it).
    pub fn clear(&mut self) {
        self.tracks.clear();
        self.shuffle_indices.clear();
        self.current_index = None;
    }

    /// Clear history and up-next but keep the currently playing track.
    pub fn clear_keeping_current(&mut self) {
        if let Some(curr) = self.current_index {
            let current_track = self.tracks[curr].clone();
            self.tracks.clear();
            self.tracks.push(current_track);
            self.current_index = Some(0);
            self.rebuild_shuffle_indices();
        } else {
            self.clear();
        }
    }

    /// Clear only the upcoming tracks, leaving history and current track.
    pub fn clear_up_next(&mut self) {
        if let Some(curr) = self.current_index {
            if curr + 1 < self.tracks.len() {
                self.tracks.drain((curr + 1)..);
                self.rebuild_shuffle_indices();
            }
        } else {
            // If stopped, there is no up next. Do nothing.
        }
    }

    /// Clear the previously played tracks.
    pub fn clear_history(&mut self) {
        if let Some(curr) = self.current_index {
            if curr > 0 {
                self.tracks.drain(0..curr);
                self.rebuild_shuffle_indices();
                self.current_index = Some(0);
            }
        } else {
            // If stopped, everything is history, so clear everything.
            self.clear();
        }
    }

    /// Play a track immediately by inserting it after the current track.
    pub fn play_now(&mut self, track: Track) {
        let insert_idx = if let Some(curr) = self.current_index {
            curr + 1
        } else {
            0
        };

        if self.shuffle {
            // Push to end of natural order
            let actual_idx = self.tracks.len();
            self.tracks.push(track);
            // Insert into play order right after current
            self.shuffle_indices.insert(insert_idx, actual_idx);
        } else {
            // Insert directly into natural order
            if insert_idx <= self.tracks.len() {
                self.tracks.insert(insert_idx, track);
            } else {
                self.tracks.push(track);
            }
            self.rebuild_shuffle_indices();
        }
        
        self.current_index = Some(insert_idx);
    }

    /// Move a track from one position to another in the play order (for drag-and-drop reordering).
    pub fn move_item(&mut self, from: usize, to: usize) {
        if from >= self.tracks.len() || to >= self.tracks.len() {
            return;
        }

        if self.shuffle {
            // In shuffle mode, we only change the play order (shuffle_indices)
            let idx = self.shuffle_indices.remove(from);
            self.shuffle_indices.insert(to, idx);
        } else {
            // In normal mode, we change the actual tracks array
            let track = self.tracks.remove(from);
            self.tracks.insert(to, track);
            self.rebuild_shuffle_indices();
        }

        // Update current_index so playback doesn't jump
        if let Some(c_idx) = self.current_index {
            if c_idx == from {
                self.current_index = Some(to);
            } else if from < c_idx && to >= c_idx {
                self.current_index = Some(c_idx - 1);
            } else if from > c_idx && to <= c_idx {
                self.current_index = Some(c_idx + 1);
            }
        }
    }

    /// Replace the entire queue with new tracks and reset to the beginning.
    pub fn replace(&mut self, tracks: Vec<Track>) {
        self.tracks = tracks;
        self.current_index = if self.tracks.is_empty() {
            None
        } else {
            Some(0)
        };
        self.rebuild_shuffle_indices();
        if self.shuffle {
            self.do_shuffle();
        }
    }

    // =========================================================================
    // Navigation
    // =========================================================================

    /// Get the current track (if any).
    pub fn current(&self) -> Option<&Track> {
        let idx = self.current_index?;
        let actual_idx = self.resolve_index(idx)?;
        self.tracks.get(actual_idx)
    }

    /// Move to the next track and return it.
    /// If `user_initiated` is true, we bypass RepeatMode::One and skip to the next track.
    pub fn next(&mut self, user_initiated: bool) -> Option<&Track> {
        if self.tracks.is_empty() {
            return None;
        }

        let len = self.tracks.len();
        let current = match self.current_index {
            Some(idx) => idx,
            None => return None,
        };

        if self.repeat_mode == RepeatMode::One && !user_initiated {
            // Natural track end — stay on the same track
            return self.current();
        }

        // Otherwise, move to the next track
        match self.repeat_mode {
            RepeatMode::All => {
                // Wrap around to the beginning when we reach the end
                self.current_index = Some((current + 1) % len);
            }
            RepeatMode::One | RepeatMode::Off => {
                if current + 1 < len {
                    self.current_index = Some(current + 1);
                } else {
                    // Reached the end — no more tracks
                    self.current_index = None;
                    return None;
                }
            }
        }

        self.current()
    }

    /// Move to the previous track and return it.
    /// If `user_initiated` is true, we bypass RepeatMode::One and skip to the previous track.
    pub fn previous(&mut self, user_initiated: bool) -> Option<&Track> {
        if self.tracks.is_empty() {
            return None;
        }

        let len = self.tracks.len();
        let current = match self.current_index {
            Some(idx) => idx,
            None => return None,
        };

        if self.repeat_mode == RepeatMode::One && !user_initiated {
            return self.current();
        }

        match self.repeat_mode {
            RepeatMode::All => {
                // Wrap around to the end
                if current == 0 {
                    self.current_index = Some(len - 1);
                } else {
                    self.current_index = Some(current - 1);
                }
            }
            RepeatMode::One | RepeatMode::Off => {
                if current > 0 {
                    self.current_index = Some(current - 1);
                } else {
                    return None;
                }
            }
        }

        self.current()
    }

    /// Jump to a specific index in the queue.
    pub fn jump_to(&mut self, index: usize) -> Option<&Track> {
        if index < self.tracks.len() {
            self.current_index = Some(index);
            self.current()
        } else {
            None
        }
    }

    // =========================================================================
    // Shuffle
    // =========================================================================

    /// Enable or disable shuffle mode.
    pub fn set_shuffle(&mut self, enabled: bool) {
        // Resolve current track before shuffling so we know what is playing NOW
        let actual_current = self.current_index.and_then(|idx| self.resolve_index(idx));
        
        self.shuffle = enabled;
        if enabled {
            self.do_shuffle();
            
            // If we had a current track before shuffling, ensure it stays the current track
            // by updating current_index to its new position in the shuffled list
            if let Some(actual) = actual_current {
                if let Some(shuffled_pos) = self.shuffle_indices.iter().position(|&x| x == actual) {
                    self.current_index = Some(shuffled_pos);
                }
            }
        } else {
            // Restore natural order
            self.rebuild_shuffle_indices();
            self.current_index = actual_current;
        }
    }

    /// Returns whether shuffle is currently enabled.
    pub fn is_shuffle(&self) -> bool {
        self.shuffle
    }

    /// Set the repeat mode.
    pub fn set_repeat_mode(&mut self, mode: RepeatMode) {
        self.repeat_mode = mode;
    }

    /// Get the current repeat mode.
    pub fn get_repeat_mode(&self) -> RepeatMode {
        self.repeat_mode
    }

    /// Get all tracks in their current play order (natural or shuffled).
    pub fn get_play_order_tracks(&self) -> Vec<Track> {
        if self.shuffle {
            self.shuffle_indices.iter().map(|&idx| self.tracks[idx].clone()).collect()
        } else {
            self.tracks.clone()
        }
    }

    /// Get all tracks in the queue (in their natural order).
    pub fn get_tracks(&self) -> &[Track] {
        &self.tracks
    }

    /// Get the number of tracks in the queue.
    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    /// Check if the queue is empty.
    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    /// Get the current playback index (relative to play order)
    pub fn get_current_index(&self) -> Option<usize> {
        self.current_index
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /// Resolve a "play order" index to an actual index in `self.tracks`.
    /// When shuffle is on, we go through `shuffle_indices`.
    fn resolve_index(&self, order_index: usize) -> Option<usize> {
        if self.shuffle {
            self.shuffle_indices.get(order_index).copied()
        } else {
            if order_index < self.tracks.len() {
                Some(order_index)
            } else {
                None
            }
        }
    }

    /// Rebuild shuffle_indices to be [0, 1, 2, ..., n-1] (natural order).
    fn rebuild_shuffle_indices(&mut self) {
        self.shuffle_indices = (0..self.tracks.len()).collect();
    }

    /// Perform Fisher-Yates shuffle on the indices.
    /// It keeps the already played tracks and current track in their natural order,
    /// and only shuffles the upcoming (unplayed) tracks.
    fn do_shuffle(&mut self) {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        use std::time::SystemTime;

        if self.tracks.len() <= 1 {
            return;
        }

        let actual_current = self.current_index.and_then(|idx| self.resolve_index(idx));

        // Determine the split point: everything before this point (history + current) stays intact.
        // Everything after this point is shuffled.
        let split_point = match actual_current {
            Some(actual) => actual + 1,
            None => 0,
        };

        // Create the new shuffle_indices list
        self.shuffle_indices.clear();

        // 1. Preserve history and the current track in their natural order
        for i in 0..split_point {
            if i < self.tracks.len() {
                self.shuffle_indices.push(i);
            }
        }

        // 2. Create a pool of upcoming tracks to shuffle
        let mut pool: Vec<usize> = (split_point..self.tracks.len()).collect();

        let len = pool.len();
        if len > 1 {
            let seed = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();

            let mut hasher = DefaultHasher::new();
            seed.hash(&mut hasher);
            let mut rng_state = hasher.finish();

            for i in (1..len).rev() {
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 7;
                rng_state ^= rng_state << 17;
                let j = (rng_state as usize) % (i + 1);
                pool.swap(i, j);
            }
        }

        // 3. Append the shuffled pool
        self.shuffle_indices.extend(pool);
    }
}

// Implement Default so callers can use PlaybackQueue::default()
impl Default for PlaybackQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri managed-state wrapper for the playback queue.
/// Lives here (not in commands/) because it is part of the audio domain.
pub struct QueueState(pub std::sync::Mutex<PlaybackQueue>);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Track;

    fn make_track(id: &str, title: &str) -> Track {
        Track {
            id: id.to_string(),
            title: title.to_string(),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Artist".to_string(),
            genre: "Genre".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 180.0,
            file_path: format!("/music/{}.mp3", id),
            file_size: 1024,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn add_increases_length() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        assert_eq!(q.tracks.len(), 2);
    }

    #[test]
    fn remove_track_after_current_leaves_index_unchanged() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.add(make_track("3", "C"));
        q.current_index = Some(1); // playing B
        q.remove(2);               // remove C (after current)
        assert_eq!(q.current_index, Some(1));
    }

    #[test]
    fn remove_track_before_current_shifts_index_down() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.add(make_track("3", "C"));
        q.current_index = Some(2); // playing C (index 2)
        q.remove(0);               // remove A (before current)
        assert_eq!(q.current_index, Some(1), "index should shift from 2 → 1");
    }

    #[test]
    fn remove_current_track_advances_or_clears() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.current_index = Some(0);
        q.remove(0); // remove currently playing track
        // current_index should still be valid or None
        assert!(q.current_index.map_or(true, |i| i < q.tracks.len()));
    }

    #[test]
    fn remove_last_track_clears_index() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.current_index = Some(0);
        q.remove(0);
        assert_eq!(q.current_index, None);
    }

    #[test]
    fn next_with_repeat_one_stays_on_same_track() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.current_index = Some(0);
        q.repeat_mode = RepeatMode::One;
        let next = q.next(false); // not user-initiated, so RepeatOne applies
        assert_eq!(next.map(|t| t.id.as_str()), Some("1"));
    }

    #[test]
    fn next_with_repeat_one_user_initiated_advances() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.current_index = Some(0);
        q.repeat_mode = RepeatMode::One;
        let next = q.next(true); // user skips, should advance
        assert_eq!(next.map(|t| t.id.as_str()), Some("2"));
    }

    #[test]
    fn next_with_repeat_all_wraps_around() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.current_index = Some(1); // on last track
        q.repeat_mode = RepeatMode::All;
        let next = q.next(false);
        assert_eq!(next.map(|t| t.id.as_str()), Some("1")); // wraps to first
    }

    #[test]
    fn next_without_repeat_at_end_returns_none() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.current_index = Some(0);
        q.repeat_mode = RepeatMode::Off;
        let next = q.next(false);
        assert!(next.is_none());
    }

    #[test]
    fn set_shuffle_preserves_current_track() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.add(make_track("3", "C"));
        q.current_index = Some(1); // playing B
        q.set_shuffle(true);
        // After shuffle, the current track should still be B
        let current = q.current_index
            .map(|i| q.shuffle_indices[i])
            .map(|ti| &q.tracks[ti]);
        assert_eq!(current.map(|t| t.id.as_str()), Some("2"));
    }

    #[test]
    fn jump_to_out_of_bounds_is_safe() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        let result = q.jump_to(99);
        assert!(result.is_none());
    }

    #[test]
    fn play_now_sets_current_to_new_track() {
        let mut q = PlaybackQueue::new();
        q.add(make_track("1", "A"));
        q.add(make_track("2", "B"));
        q.current_index = Some(1);
        q.play_now(make_track("3", "C"));
        // C should be inserted after current and set as current
        let current = q.current_index.map(|i| &q.tracks[i]);
        assert_eq!(current.map(|t| t.id.as_str()), Some("3"));
    }
}

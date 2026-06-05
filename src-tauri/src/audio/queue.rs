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

    /// Move a track from one position to another (for drag-and-drop reordering).
    pub fn move_item(&mut self, from: usize, to: usize) {
        if from >= self.tracks.len() || to >= self.tracks.len() {
            return;
        }

        let track = self.tracks.remove(from);
        self.tracks.insert(to, track);

        // Rebuild shuffle indices to match new order
        self.rebuild_shuffle_indices();
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
    /// Returns None if we've reached the end (and repeat is off).
    pub fn next(&mut self) -> Option<&Track> {
        if self.tracks.is_empty() {
            return None;
        }

        let len = self.tracks.len();
        let current = match self.current_index {
            Some(idx) => idx,
            None => return None,
        };

        match self.repeat_mode {
            RepeatMode::One => {
                // Stay on the same track — just return current
                // current_index stays the same
            }
            RepeatMode::All => {
                // Wrap around to the beginning when we reach the end
                self.current_index = Some((current + 1) % len);
            }
            RepeatMode::Off => {
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
    /// Returns None if we're at the beginning (and repeat is off).
    pub fn previous(&mut self) -> Option<&Track> {
        if self.tracks.is_empty() {
            return None;
        }

        let len = self.tracks.len();
        let current = match self.current_index {
            Some(idx) => idx,
            None => return None,
        };

        match self.repeat_mode {
            RepeatMode::One => {
                // Stay on the same track
            }
            RepeatMode::All => {
                // Wrap around to the end
                if current == 0 {
                    self.current_index = Some(len - 1);
                } else {
                    self.current_index = Some(current - 1);
                }
            }
            RepeatMode::Off => {
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
        self.shuffle = enabled;
        if enabled {
            self.do_shuffle();
        } else {
            // Restore natural order
            self.rebuild_shuffle_indices();
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

    /// Get the current playback index
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
    /// Fisher-Yates is the standard unbiased shuffle algorithm —
    /// it's O(n) and gives each permutation equal probability.
    fn do_shuffle(&mut self) {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        use std::time::SystemTime;

        let len = self.shuffle_indices.len();
        if len <= 1 {
            return;
        }

        // Simple pseudo-random number generator seeded with current time.
        // We avoid pulling in the `rand` crate for this simple use case.
        let seed = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        let mut rng_state = hasher.finish();

        // Fisher-Yates shuffle (in-place, O(n))
        for i in (1..len).rev() {
            // Simple xorshift-style PRNG
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 7;
            rng_state ^= rng_state << 17;
            let j = (rng_state as usize) % (i + 1);
            self.shuffle_indices.swap(i, j);
        }

        // If there's a current track, try to move it to the front of the
        // shuffled list so the currently playing track stays current
        if let Some(current_order_idx) = self.current_index {
            if let Some(actual_track_idx) = self.resolve_index(current_order_idx) {
                // Find where this track ended up in the shuffled order
                if let Some(pos) = self
                    .shuffle_indices
                    .iter()
                    .position(|&x| x == actual_track_idx)
                {
                    // Move it to position 0
                    self.shuffle_indices.swap(0, pos);
                    self.current_index = Some(0);
                }
            }
        }
    }
}

// Implement Default so callers can use PlaybackQueue::default()
impl Default for PlaybackQueue {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// commands/library.rs — Tauri commands for music library management
// =============================================================================
//
// These commands handle:
//   - Adding/removing library folders
//   - Scanning folders for audio files
//   - Browsing tracks, albums, artists, genres
//   - Searching the library
//   - Getting track artwork
// =============================================================================

use std::collections::{HashMap, HashSet};
#[cfg(any(target_os = "windows", test))]
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::ArtworkCache;
use crate::NormalizationAnalysisLock;
use crate::ScanLock;
use crate::error::AppError;
use crate::library::database::Database;
use crate::library::metadata;
use crate::library::play_history::PlayHistoryWriter;
use crate::library::scanner;
use crate::models::{
    Album, Artist, NormalizationAnalysisStatus, NormalizationProgress, ScanComplete, ScanIssue,
    ScanPayload, ScanProgress, ScanRootOutcome, ScanRootStatus, ScanStatus, SearchResults,
    TopArtist, Track,
};
use image::ImageFormat;
use image::{ImageReader, Limits};
use tauri_specta::Event as _;

const MAX_SCAN_ERROR_DETAILS: usize = 100;

// =============================================================================
// Library folder management
// =============================================================================

#[tauri::command]
#[specta::specta]
pub async fn pick_library_folders(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<Vec<String>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    #[cfg(target_os = "linux")]
    {
        app.dialog()
            .file()
            .set_title("Select Music Folder")
            .pick_folder(move |res| {
                let _ = tx.send(res.map(|p| vec![p]));
            });
    }

    #[cfg(not(target_os = "linux"))]
    {
        app.dialog()
            .file()
            .set_title("Select Music Folders")
            .pick_folders(move |res| {
                let _ = tx.send(res);
            });
    }

    let Some(selected) = rx.await.unwrap_or(None) else {
        return Ok(Vec::new());
    };

    let paths = selected
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|_| AppError::Other("Selected folder is not local".to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut registered = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path
            .canonicalize()
            .map_err(|e| AppError::Other(format!("Invalid music folder: {e}")))?;
        if !path.is_dir() {
            return Err(AppError::Other(
                "Selected path is not a directory".to_string(),
            ));
        }
        let path = path.to_string_lossy().into_owned();
        db.add_library_folder(&path).map_err(AppError::from)?;
        registered.push(path);
    }
    Ok(registered)
}

/// Remove a music folder from the library.
///
/// Frontend: `invoke('remove_library_folder', { path: '/Users/me/Music' })`
#[tauri::command]
#[specta::specta]
pub fn remove_library_folder(path: String, db: State<'_, Database>) -> Result<(), AppError> {
    db.remove_library_folder(&path).map_err(AppError::from)?;
    Ok(())
}

/// Get all registered library folder paths.
///
/// Frontend: `const folders = await invoke('get_library_folders')`
#[tauri::command]
#[specta::specta]
pub fn get_library_folders(db: State<'_, Database>) -> Result<Vec<String>, AppError> {
    db.get_library_folders().map_err(AppError::from)
}

fn resolve_track_path_to_reveal(db: &Database, track_id: &str) -> Result<PathBuf, AppError> {
    let track = db
        .get_track(track_id)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound("Track not found in the library".to_string()))?;
    let path = std::fs::canonicalize(&track.file_path).map_err(|error| {
        AppError::NotFound(format!("Track file is no longer available: {error}"))
    })?;
    if !path.is_file() {
        return Err(AppError::NotFound(
            "Track file is no longer available".to_string(),
        ));
    }
    Ok(path)
}

fn build_reveal_command(path: &Path) -> Result<Command, AppError> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        Ok(command)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new("explorer.exe");
        command.raw_arg(windows_explorer_raw_arg(path.as_os_str()));
        Ok(command)
    }
    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().ok_or_else(|| {
            AppError::Other("The track file does not have a containing folder".to_string())
        })?;
        let mut command = Command::new("xdg-open");
        command.arg(parent);
        Ok(command)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err(AppError::Other(
            "Revealing tracks in the file manager is not supported on this platform".to_string(),
        ))
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_explorer_raw_arg(path: &OsStr) -> OsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let normalized = normalize_windows_explorer_path(&path.encode_wide().collect::<Vec<_>>());
        let mut argument = OsString::from("/select,\"");
        argument.push(OsString::from_wide(&normalized));
        argument.push("\"");
        argument
    }
    #[cfg(not(windows))]
    {
        let mut argument = OsString::from("/select,\"");
        argument.push(path);
        argument.push("\"");
        argument
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_explorer_path(path: &[u16]) -> Vec<u16> {
    const VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    if !path.starts_with(&VERBATIM_PREFIX) {
        return path.to_vec();
    }

    let path = &path[VERBATIM_PREFIX.len()..];
    let has_unc_prefix = path.len() >= 4
        && (path[0] == b'U' as u16 || path[0] == b'u' as u16)
        && (path[1] == b'N' as u16 || path[1] == b'n' as u16)
        && (path[2] == b'C' as u16 || path[2] == b'c' as u16)
        && path[3] == b'\\' as u16;
    if has_unc_prefix {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&path[4..]);
        return normalized;
    }

    path.to_vec()
}

fn reveal_path_in_file_manager(path: &Path) -> Result<(), AppError> {
    let mut child = build_reveal_command(path)?.spawn()?;
    // File managers can exit non-zero after success, so the status is ignored; the wait only reaps the child.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Reveal a library track using its database ID, never a frontend-provided path.
#[tauri::command]
#[specta::specta]
pub fn reveal_track_in_folder(
    track_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let path = {
        let db = db
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        resolve_track_path_to_reveal(&db, &track_id)?
    };
    reveal_path_in_file_manager(&path)
}

// =============================================================================
// Library scanning
// =============================================================================

fn scan_worker_count(available_parallelism: usize) -> usize {
    available_parallelism.clamp(1, 4)
}

fn spawn_scan_task<I, O, W>(
    tasks: &mut tokio::task::JoinSet<(String, Result<O, String>)>,
    task_paths: &mut HashMap<tokio::task::Id, String>,
    path: String,
    input: I,
    worker: Arc<W>,
) where
    I: Send + 'static,
    O: Send + 'static,
    W: Fn(I) -> Result<O, String> + Send + Sync + 'static,
{
    let tracked_path = path.clone();
    let task_id = tasks.spawn_blocking(move || (path, worker(input))).id();
    task_paths.insert(task_id, tracked_path);
}

/// Run blocking scan tasks as they become available instead of submitting
/// fixed-size batches that delay fast results behind earlier slow files.
/// Dropping this future drops the JoinSet, so queued work is not submitted
/// after cancellation and at most `worker_count` jobs remain in flight.
async fn run_bounded_scan_tasks<J, I, O, W, C>(
    jobs: J,
    worker_count: usize,
    worker: W,
    mut on_result: C,
) where
    J: IntoIterator<Item = (String, I)> + Send,
    J::IntoIter: Send,
    I: Send + 'static,
    O: Send + 'static,
    W: Fn(I) -> Result<O, String> + Send + Sync + 'static,
    C: FnMut(String, Result<O, String>),
{
    let worker_count = worker_count.max(1);
    let worker = Arc::new(worker);
    let mut pending = jobs.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_paths = HashMap::new();

    while tasks.len() < worker_count {
        let Some((path, input)) = pending.next() else {
            break;
        };
        spawn_scan_task(
            &mut tasks,
            &mut task_paths,
            path,
            input,
            Arc::clone(&worker),
        );
    }

    while let Some(result) = tasks.join_next_with_id().await {
        match result {
            Ok((task_id, (path, result))) => {
                task_paths.remove(&task_id);
                on_result(path, result);
            }
            Err(error) => {
                let path = task_paths
                    .remove(&error.id())
                    .unwrap_or_else(|| "unknown scan file".to_string());
                on_result(path, Err(format!("Metadata worker failed: {error}")));
            }
        }

        if let Some((path, input)) = pending.next() {
            spawn_scan_task(
                &mut tasks,
                &mut task_paths,
                path,
                input,
                Arc::clone(&worker),
            );
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ScanSummary {
    total_files: usize,
    processed_files: usize,
    current_file: String,
    new_tracks: usize,
    changed_tracks: usize,
    removed_tracks: usize,
    root_outcomes: Vec<ScanRootOutcome>,
    folder_errors: Vec<ScanIssue>,
    file_errors: Vec<ScanIssue>,
    message: Option<String>,
}

impl ScanSummary {
    fn payload(
        &self,
        status: ScanStatus,
        error: Option<&str>,
        include_failure_details: bool,
    ) -> ScanPayload {
        let partial_success = status == ScanStatus::Complete
            && (!self.folder_errors.is_empty() || !self.file_errors.is_empty());
        let folder_errors = if include_failure_details {
            self.folder_errors
                .iter()
                .take(MAX_SCAN_ERROR_DETAILS)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let file_errors = if include_failure_details {
            self.file_errors
                .iter()
                .take(MAX_SCAN_ERROR_DETAILS)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let root_outcomes = self
            .root_outcomes
            .iter()
            .take(MAX_SCAN_ERROR_DETAILS)
            .map(|root| {
                let mut root = root.clone();
                if !include_failure_details {
                    root.error = None;
                }
                root
            })
            .collect::<Vec<_>>();
        ScanPayload {
            total_files: self.total_files,
            processed_files: self.processed_files,
            current_file: self.current_file.clone(),
            status,
            new_tracks: self.new_tracks,
            changed_tracks: self.changed_tracks,
            removed_tracks: self.removed_tracks,
            skipped_files: self.file_errors.len(),
            failed_folders: self.folder_errors.len(),
            partial_success,
            error: error.map(str::to_string),
            error_details_truncated: include_failure_details
                && (self.folder_errors.len() > MAX_SCAN_ERROR_DETAILS
                    || self.file_errors.len() > MAX_SCAN_ERROR_DETAILS),
            root_outcomes_truncated: self.root_outcomes.len() > MAX_SCAN_ERROR_DETAILS,
            root_outcomes,
            folder_errors,
            file_errors,
            message: self.message.clone(),
            total_tracks: self.message.as_ref().map(|_| 0),
        }
    }
}

#[derive(Default)]
struct ScanDiscovery {
    scanned_roots: Vec<(String, Vec<String>)>,
    audio_empty_subtrees: Vec<String>,
    files: Vec<String>,
    root_outcomes: Vec<ScanRootOutcome>,
    folder_errors: Vec<ScanIssue>,
}

fn scan_folders(folders: &[String]) -> ScanDiscovery {
    let mut discovery = ScanDiscovery::default();
    let mut seen_files = HashSet::new();
    for folder in folders {
        match scanner::scan_directory_with_subtrees(folder) {
            Ok(scan) => {
                let discovered_files = scan.audio_files.len();
                let pruning_skipped = scan.audio_files.is_empty();
                // Registered folder paths are canonicalized when selected, so
                // overlapping walks report the same scanner path. Keep one
                // candidate per path before fingerprint lookup and ID creation,
                // while retaining each root's full walk for pruning decisions.
                for file_path in &scan.audio_files {
                    if seen_files.insert(file_path.clone()) {
                        discovery.files.push(file_path.clone());
                    }
                }
                discovery
                    .audio_empty_subtrees
                    .extend(scan.audio_empty_subtrees);
                discovery
                    .scanned_roots
                    .push((folder.clone(), scan.audio_files));
                discovery.root_outcomes.push(ScanRootOutcome {
                    path: folder.clone(),
                    status: ScanRootStatus::Complete,
                    discovered_files,
                    pruning_skipped,
                    ..ScanRootOutcome::default()
                });
            }
            Err(error) => {
                discovery.root_outcomes.push(ScanRootOutcome {
                    path: folder.clone(),
                    status: ScanRootStatus::Error,
                    pruning_skipped: true,
                    error: Some(error.clone()),
                    ..ScanRootOutcome::default()
                });
                discovery.folder_errors.push(ScanIssue {
                    path: folder.clone(),
                    error,
                });
            }
        }
    }
    discovery
}

fn emit_scan_progress(app: &AppHandle, summary: &ScanSummary, status: ScanStatus) {
    let _ = ScanProgress(summary.payload(status, None, false)).emit(app);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanEvent {
    Progress,
    Complete,
}

#[cfg(test)]
impl ScanEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Progress => "scan-progress",
            Self::Complete => "scan-complete",
        }
    }
}

fn finish_scan<F>(
    summary: &ScanSummary,
    outcome: Result<(), AppError>,
    mut emit: F,
) -> Result<ScanPayload, AppError>
where
    F: FnMut(ScanEvent, &ScanPayload),
{
    match outcome {
        Ok(()) => {
            let payload = summary.payload(ScanStatus::Complete, None, true);
            emit(ScanEvent::Progress, &payload);
            emit(ScanEvent::Complete, &payload);
            Ok(payload)
        }
        Err(error) => {
            let message = error.to_string();
            let mut failed_summary = summary.clone();
            for root in &mut failed_summary.root_outcomes {
                if matches!(
                    root.status,
                    ScanRootStatus::Complete | ScanRootStatus::Partial
                ) {
                    root.status = ScanRootStatus::Aborted;
                    root.pruning_skipped = true;
                    root.error = Some(message.clone());
                }
            }
            let payload = failed_summary.payload(ScanStatus::Error, Some(&message), true);
            emit(ScanEvent::Progress, &payload);
            emit(ScanEvent::Complete, &payload);
            Err(error)
        }
    }
}

fn prune_scanned_roots(
    db: &Database,
    scanned_roots: &[(String, Vec<String>)],
    audio_empty_subtrees: &[String],
    file_errors: &[ScanIssue],
) -> Result<usize, AppError> {
    let roots_without_file_errors: Vec<_> = scanned_roots
        .iter()
        .filter(|(root, _)| {
            !file_errors.iter().any(|issue| {
                std::path::Path::new(&issue.path).starts_with(std::path::Path::new(root))
            })
        })
        .cloned()
        .collect();
    db.remove_missing_tracks_from_scanned_roots(&roots_without_file_errors, audio_empty_subtrees)
        .map_err(AppError::from)
}

/// Scan all registered library folders for audio files.
/// This is a potentially long-running operation — progress events are emitted.
///
/// Frontend: `invoke('scan_library')`
///
/// Events emitted:
///   - `scan-progress`: preserves the existing `total_files`, `processed_files`,
///     `current_file`, and `status` fields, with additive failure summaries and
///     bounded named outcomes for each configured root. Root outcomes use
///     `complete`, `partial`, `error`, or `aborted`; `pruning_skipped` and
///     `protected_empty_subtrees` explain why old tracks may be retained.
///   - `scan-complete`: terminal summary emitted for both success and failure.
///
/// The scan:
///   1. Gets all registered library folders
///   2. Walks each folder recursively for audio files
///   3. Extracts metadata from each file
///   4. Stores/updates tracks in the database
///   5. Removes missing tracks only under fully traversed roots without metadata
///      failures. Existing subtrees with no supported audio remain protected,
///      since an empty directory can also be an offline mount. Removing the
///      last audio file from an existing directory therefore retains its prior
///      tracks until audio returns or the library folder is explicitly removed.
#[tauri::command]
#[specta::specta]
pub async fn scan_library(
    app: AppHandle,
    db: State<'_, Database>,
    scan_lock: State<'_, ScanLock>,
) -> Result<ScanPayload, AppError> {
    // Prevent concurrent scans. ScanGuard releases the lock on drop.
    struct ScanGuard<'a>(&'a ScanLock);
    impl Drop for ScanGuard<'_> {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    if !scan_lock.try_acquire() {
        // No scan session started, so avoid emitting a terminal event that
        // could incorrectly end the already-running scan's UI state.
        return Err(AppError::ScanBusy);
    }
    let _guard = ScanGuard(&scan_lock);

    let mut summary = ScanSummary::default();
    emit_scan_progress(&app, &summary, ScanStatus::Scanning);
    let outcome = scan_library_inner(db.inner(), &mut summary, |summary, status| {
        emit_scan_progress(&app, summary, status);
    })
    .await;
    finish_scan(&summary, outcome, |event, payload| {
        let result = match event {
            ScanEvent::Progress => ScanProgress(payload.clone()).emit(&app),
            ScanEvent::Complete => ScanComplete(payload.clone()).emit(&app),
        };
        if let Err(error) = result {
            eprintln!("[LibraryScan] Failed to emit terminal scan event: {error}");
        }
    })
}

async fn scan_library_inner<F>(
    db: &Database,
    summary: &mut ScanSummary,
    emit_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(&ScanSummary, ScanStatus) + Send,
{
    let folders = db.get_library_folders().map_err(AppError::from)?;
    scan_library_inner_with_folders(db, summary, folders, emit_progress).await
}

async fn scan_library_inner_with_folders<F>(
    db: &Database,
    summary: &mut ScanSummary,
    folders: Vec<String>,
    mut emit_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(&ScanSummary, ScanStatus) + Send,
{
    if folders.is_empty() {
        summary.message = Some("No library folders configured. Add a folder first.".to_string());
        return Ok(());
    }

    // Isolate root failures: successful folders remain usable and failed roots
    // are omitted from pruning, while their paths/errors are reported.
    let discovery = scan_folders(&folders);
    let scanned_roots = discovery.scanned_roots;
    let audio_empty_subtrees = discovery.audio_empty_subtrees;
    let all_files = discovery.files;
    summary.folder_errors = discovery.folder_errors;
    summary.root_outcomes = discovery.root_outcomes;
    for root in &mut summary.root_outcomes {
        root.protected_empty_subtrees = audio_empty_subtrees
            .iter()
            .filter(|subtree| {
                std::path::Path::new(subtree).starts_with(std::path::Path::new(&root.path))
            })
            .count();
    }
    summary.total_files = all_files.len();
    emit_progress(summary, ScanStatus::Scanning);

    if scanned_roots.is_empty() {
        return Err(AppError::Other(
            "All configured library folders failed to scan.".to_string(),
        ));
    }

    // Pre-load existing file fingerprints so changed files are refreshed too.
    let existing_by_path: HashMap<String, crate::library::database::TrackFingerprint> = db
        .get_track_fingerprints()
        .map_err(AppError::from)?
        .into_iter()
        .map(|fingerprint| (fingerprint.file_path.clone(), fingerprint))
        .collect();

    #[derive(Clone)]
    struct ScanCandidate {
        path: String,
        id: String,
        date_added: String,
        is_changed: bool,
    }

    let date_added = crate::utils::current_timestamp();
    let mut candidates = Vec::new();
    for file_path in all_files {
        let file_meta = std::fs::metadata(&file_path).ok();
        let file_size = file_meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        let file_modified_unix = file_meta
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);

        match existing_by_path.get(&file_path) {
            Some(existing)
                if existing.file_size == file_size
                    && existing.file_modified_unix == file_modified_unix => {}
            Some(existing) => candidates.push(ScanCandidate {
                path: file_path,
                id: existing.id.clone(),
                date_added: existing.date_added.clone(),
                is_changed: true,
            }),
            None => candidates.push(ScanCandidate {
                path: file_path,
                id: uuid::Uuid::new_v4().to_string(),
                date_added: date_added.clone(),
                is_changed: false,
            }),
        }
    }

    let candidate_count = candidates.len();

    // Unchanged tracks are already accounted for; `skipped_files` is reserved
    // for files whose metadata failed and which could not be imported.
    summary.processed_files = summary.total_files.saturating_sub(candidate_count);
    emit_progress(
        summary,
        if candidate_count == 0 {
            ScanStatus::Scanning
        } else {
            ScanStatus::Processing
        },
    );

    let worker_count = scan_worker_count(
        std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(2),
    );
    let mut upsert_tracks: Vec<Track> = Vec::with_capacity(candidate_count);
    let mut extracted_new_tracks = 0usize;
    let mut extracted_changed_tracks = 0usize;
    let mut processing_count = 0usize;
    let jobs = candidates
        .into_iter()
        .map(|candidate| (candidate.path.clone(), candidate));
    run_bounded_scan_tasks(
        jobs,
        worker_count,
        |candidate| {
            metadata::extract_metadata_no_artwork(&candidate.path).map(|meta| (candidate, meta))
        },
        |path, result| {
            summary.current_file = path.clone();
            match result {
                Ok((candidate, meta)) => {
                    if candidate.is_changed {
                        extracted_changed_tracks += 1;
                    } else {
                        extracted_new_tracks += 1;
                    }
                    upsert_tracks.push(Track::from_metadata(
                        meta,
                        candidate.id,
                        candidate.date_added,
                    ));
                }
                Err(error) => summary.file_errors.push(ScanIssue { path, error }),
            }

            processing_count += 1;
            summary.processed_files += 1;
            // Emit on the first completion and every 50 thereafter, so fast
            // out-of-order results stay visible without flooding IPC.
            if processing_count == 1
                || processing_count.is_multiple_of(50)
                || processing_count == candidate_count
            {
                emit_progress(summary, ScanStatus::Processing);
            }
        },
    )
    .await;
    summary.current_file.clear();

    for root in &mut summary.root_outcomes {
        let failures = summary
            .file_errors
            .iter()
            .filter(|issue| {
                std::path::Path::new(&issue.path).starts_with(std::path::Path::new(&root.path))
            })
            .count();
        if failures > 0 && root.status == ScanRootStatus::Complete {
            root.status = ScanRootStatus::Partial;
            root.skipped_files = failures;
            root.pruning_skipped = true;
            root.error = Some(format!(
                "{failures} file(s) failed metadata extraction; stale tracks were retained for this root"
            ));
        }
    }

    // Phase 3: Batch-insert all new/changed tracks in a single transaction
    if !upsert_tracks.is_empty() {
        db.upsert_tracks_batch(&upsert_tracks)
            .map_err(AppError::from)?;
        // Counts represent persisted changes. If the batch transaction fails,
        // finish_scan reports zero new/changed tracks in its terminal error.
        summary.new_tracks = extracted_new_tracks;
        summary.changed_tracks = extracted_changed_tracks;
    }

    // Keep roots containing failed metadata files out of pruning, while other
    // successfully completed roots can still reconcile their stale tracks.
    summary.removed_tracks = prune_scanned_roots(
        db,
        &scanned_roots,
        &audio_empty_subtrees,
        &summary.file_errors,
    )?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analyze_missing_normalization(
    app: AppHandle,
    analysis_lock: State<'_, NormalizationAnalysisLock>,
) -> Result<NormalizationAnalysisStatus, AppError> {
    if !analysis_lock.try_acquire() {
        return Ok(NormalizationAnalysisStatus {
            started: false,
            message: Some("Normalization analysis is already running.".to_string()),
        });
    }

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let release_lock = || {
            if let Some(lock) = task_app.try_state::<NormalizationAnalysisLock>() {
                lock.release();
            }
        };

        let tracks = match task_app.try_state::<Database>() {
            Some(db) => db.get_tracks_missing_normalization().unwrap_or_default(),
            None => {
                release_lock();
                return;
            }
        };

        let total = tracks.len();
        let mut analyzed = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let _ = NormalizationProgress {
            analyzed,
            total,
            skipped,
            failed,
        }
        .emit(&task_app);

        for track in tracks {
            let path = track.file_path.clone();
            let track_id = track.id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::audio::normalization::analyze_file(&path)
            })
            .await;

            match result {
                Ok(Ok(Some(analysis))) => {
                    if let Some(db) = task_app.try_state::<Database>() {
                        if db
                            .update_track_normalization(
                                &track_id,
                                analysis.gain_db,
                                analysis.peak,
                                "analysis",
                            )
                            .is_ok()
                        {
                            analyzed += 1;
                        } else {
                            failed += 1;
                        }
                    } else {
                        failed += 1;
                    }
                }
                Ok(Ok(None)) => skipped += 1,
                Ok(Err(err)) => {
                    failed += 1;
                    eprintln!("[Normalization] {err}");
                }
                Err(err) => {
                    failed += 1;
                    eprintln!("[Normalization] Analysis task failed: {err}");
                }
            }

            let processed = analyzed + skipped + failed;
            if processed == total || processed.is_multiple_of(10) {
                let _ = NormalizationProgress {
                    analyzed,
                    total,
                    skipped,
                    failed,
                }
                .emit(&task_app);
            }
        }

        release_lock();
    });

    Ok(NormalizationAnalysisStatus {
        started: true,
        message: None,
    })
}

// =============================================================================
// Library browsing
// =============================================================================

/// Get all tracks in the library.
///
/// Frontend: `const tracks = await invoke('get_all_tracks')`
#[tauri::command]
#[specta::specta]
pub fn get_all_tracks(db: State<'_, Database>) -> Result<Vec<Track>, AppError> {
    db.get_all_tracks().map_err(AppError::from)
}

/// Get all tracks for a specific album, sorted by disc then track number.
/// Avoids filtering all tracks on the frontend for large libraries.
///
/// Frontend: `const tracks = await invoke('get_album_tracks', { album, albumArtist })`
#[tauri::command]
#[specta::specta]
pub fn get_album_tracks(
    album: String,
    album_artist: String,
    db: State<'_, Database>,
) -> Result<Vec<Track>, AppError> {
    db.get_tracks_by_album_and_artist(&album, &album_artist)
        .map_err(AppError::from)
}

/// Get all albums in the library.
///
/// Frontend: `const albums = await invoke('get_albums')`
#[tauri::command]
#[specta::specta]
pub fn get_albums(db: State<'_, Database>) -> Result<Vec<Album>, AppError> {
    db.get_albums().map_err(AppError::from)
}

/// Get all artists in the library.
///
/// Frontend: `const artists = await invoke('get_artists')`
#[tauri::command]
#[specta::specta]
pub fn get_artists(db: State<'_, Database>) -> Result<Vec<Artist>, AppError> {
    db.get_artists().map_err(AppError::from)
}

/// Get all genre names in the library.
///
/// Frontend: `const genres = await invoke('get_genres')`
#[tauri::command]
#[specta::specta]
pub fn get_genres(db: State<'_, Database>) -> Result<Vec<String>, AppError> {
    db.get_genres().map_err(AppError::from)
}

/// Search across tracks, albums, and artists.
///
/// Frontend: `const results = await invoke('search', { query: 'beatles' })`
///
/// Returns a SearchResults object with matching tracks, albums, and artists.
#[tauri::command]
#[specta::specta]
pub fn search(query: String, db: State<'_, Database>) -> Result<SearchResults, AppError> {
    // Search tracks
    let tracks = db.search_tracks(&query).map_err(AppError::from)?;

    // Derive matching albums from the found tracks, counting tracks per album
    let mut album_map: std::collections::HashMap<String, Album> = std::collections::HashMap::new();
    for track in &tracks {
        let key = format!("{}|{}", track.album, track.album_artist);
        let entry = album_map.entry(key).or_insert_with(|| Album {
            name: track.album.clone(),
            artist: track.album_artist.clone(),
            year: track.year,
            track_count: 0,
            artwork_track_id: Some(track.id.clone()),
        });
        entry.track_count += 1;
    }
    let mut albums: Vec<Album> = album_map.into_values().collect();
    albums.sort_by_key(|a| a.name.to_lowercase());

    // Derive matching artists, counting tracks and unique albums per artist
    struct ArtistAcc {
        track_count: u32,
        albums: std::collections::HashSet<String>,
    }
    let mut artist_map: std::collections::HashMap<String, ArtistAcc> =
        std::collections::HashMap::new();
    for track in &tracks {
        let acc = artist_map
            .entry(track.artist.clone())
            .or_insert_with(|| ArtistAcc {
                track_count: 0,
                albums: std::collections::HashSet::new(),
            });
        acc.track_count += 1;
        acc.albums.insert(track.album.clone());
    }
    let mut artists: Vec<Artist> = artist_map
        .into_iter()
        .map(|(name, acc)| Artist {
            name,
            album_count: acc.albums.len() as u32,
            track_count: acc.track_count,
        })
        .collect();
    artists.sort_by_key(|a| a.name.to_lowercase());

    Ok(SearchResults {
        tracks,
        albums,
        artists,
    })
}

/// Artwork returned to the frontend: base64-encoded image data plus its MIME type.
#[derive(serde::Serialize, specta::Type)]
pub struct ArtworkPayload {
    pub data: String,
    pub mime_type: String,
}

/// Get the embedded artwork for a track.
/// Helper to get the embedded or folder artwork bytes for a track (cached).
pub fn fetch_raw_artwork(
    track_id: &str,
    db: &Database,
    artwork_cache: &Mutex<ArtworkCache>,
) -> Result<Option<(Vec<u8>, String)>, AppError> {
    // Look up the track to get its album identity and file path.
    let track = match db.get_track(track_id).map_err(AppError::from)? {
        Some(t) => t,
        None => return Ok(None),
    };

    // Cache key is (album, album_artist) so all tracks on the same album share
    // one entry — avoids storing N identical copies of the same cover image.
    let album_key = format!("{}||{}", track.album, track.album_artist);

    let raw_cache_key = format!("raw:{album_key}");
    if let Ok(cache) = artwork_cache.lock()
        && let Some(entry) = cache.get(&raw_cache_key)
    {
        return Ok(entry);
    }

    let meta = match metadata::extract_metadata(&track.file_path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };

    // Try embedded artwork first, then fall back to common folder image files.
    let artwork_bytes = meta.artwork.or_else(|| {
        let path = std::path::Path::new(&track.file_path);
        if let Some(parent) = path.parent() {
            let common_names = [
                "cover.jpg",
                "cover.jpeg",
                "cover.png",
                "folder.jpg",
                "folder.jpeg",
                "folder.png",
                "front.jpg",
                "front.jpeg",
                "front.png",
                "Artwork.jpg",
                "Artwork.jpeg",
                "Artwork.png",
            ];
            for entry in std::fs::read_dir(parent).ok()?.flatten() {
                if let Ok(file_type) = entry.file_type()
                    && file_type.is_file()
                    && let Some(file_name) = entry.file_name().to_str()
                {
                    let file_name_lower = file_name.to_lowercase();
                    if common_names
                        .iter()
                        .any(|name| file_name_lower == name.to_lowercase())
                        && let Ok(bytes) = read_bounded_artwork(&entry.path())
                    {
                        return Some(bytes);
                    }
                }
            }
        }
        None
    });

    let result = match artwork_bytes {
        Some(bytes) => {
            let mime_type = detect_image_mime(&bytes);
            Some((bytes, mime_type))
        }
        None => None,
    };

    if let Ok(mut cache) = artwork_cache.lock() {
        cache.insert(raw_cache_key, result.clone());
    }

    Ok(result)
}

pub const THUMBNAIL_ARTWORK_SIZE: u32 = 128;
pub const STANDARD_ARTWORK_SIZE: u32 = 384;
pub const FULLSCREEN_ARTWORK_SIZE: u32 = 768;

pub fn artwork_size_from_query(query: Option<&str>) -> u32 {
    query
        .and_then(|query| {
            query.split('&').find_map(|pair| {
                let (key, value) = pair.split_once('=')?;
                (key == "size").then(|| value.parse::<u32>().ok()).flatten()
            })
        })
        .filter(|size| {
            matches!(
                size,
                &THUMBNAIL_ARTWORK_SIZE | &STANDARD_ARTWORK_SIZE | &FULLSCREEN_ARTWORK_SIZE
            )
        })
        .unwrap_or(STANDARD_ARTWORK_SIZE)
}

fn resize_artwork(bytes: &[u8], max_edge: u32) -> Option<(Vec<u8>, String)> {
    if bytes.len() > metadata::MAX_ARTWORK_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    if image.width() <= max_edge && image.height() <= max_edge {
        return Some((bytes.to_vec(), detect_image_mime(bytes)));
    }

    let resized = image.thumbnail(max_edge, max_edge);
    let output_format = match format {
        ImageFormat::Jpeg => ImageFormat::Jpeg,
        ImageFormat::Gif => ImageFormat::Gif,
        ImageFormat::WebP => ImageFormat::WebP,
        _ => ImageFormat::Png,
    };
    let mut output = std::io::Cursor::new(Vec::new());
    resized.write_to(&mut output, output_format).ok()?;
    let mime = match output_format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => "image/png",
    };
    Some((output.into_inner(), mime.to_string()))
}

fn read_bounded_artwork(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > metadata::MAX_ARTWORK_BYTES as u64 {
        return Err(std::io::Error::other("artwork exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(metadata::MAX_ARTWORK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > metadata::MAX_ARTWORK_BYTES {
        return Err(std::io::Error::other("artwork exceeds size limit"));
    }
    Ok(bytes)
}

pub fn fetch_sized_artwork(
    track_id: &str,
    size: u32,
    db: &Database,
    artwork_cache: &Mutex<ArtworkCache>,
) -> Result<Option<(Vec<u8>, String)>, AppError> {
    let Some(track) = db.get_track(track_id).map_err(AppError::from)? else {
        return Ok(None);
    };
    let album_key = format!("{}||{}", track.album, track.album_artist);
    let cache_key = format!("sized:{album_key}:{size}");
    if let Ok(cache) = artwork_cache.lock()
        && let Some(entry) = cache.get(&cache_key)
    {
        return Ok(entry);
    }

    let raw = fetch_raw_artwork(track_id, db, artwork_cache)?;
    let result = raw.map(|(bytes, mime)| resize_artwork(&bytes, size).unwrap_or((bytes, mime)));
    if let Ok(mut cache) = artwork_cache.lock() {
        cache.insert(cache_key, result.clone());
    }
    Ok(result)
}

/// Get the embedded artwork for a track.
///
/// Frontend: `const artwork = await invoke('get_track_artwork', { trackId: '...' })`
///
/// Returns `{ data, mime_type }` or null. The frontend builds the data URL as:
/// `data:${mime_type};base64,${data}`
#[tauri::command]
#[specta::specta]
pub fn get_track_artwork(
    track_id: String,
    size: Option<u32>,
    db: State<'_, Database>,
    artwork_cache: State<'_, Mutex<ArtworkCache>>,
) -> Result<Option<ArtworkPayload>, AppError> {
    let size = size
        .filter(|size| {
            matches!(
                size,
                &THUMBNAIL_ARTWORK_SIZE | &STANDARD_ARTWORK_SIZE | &FULLSCREEN_ARTWORK_SIZE
            )
        })
        .unwrap_or(STANDARD_ARTWORK_SIZE);
    let raw = fetch_sized_artwork(&track_id, size, &db, &artwork_cache)?;
    Ok(raw.map(|(bytes, mime_type)| ArtworkPayload {
        data: base64_encode(&bytes),
        mime_type,
    }))
}

#[tauri::command]
#[specta::specta]
pub fn clear_artwork_cache(artwork_cache: State<'_, Mutex<ArtworkCache>>) -> Result<(), AppError> {
    let mut cache = artwork_cache
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    cache.clear();
    Ok(())
}

/// Detect the MIME type of image bytes from their magic number header.
fn detect_image_mime(bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x89PNG") {
        "image/png".to_string()
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg".to_string()
    } else if bytes.starts_with(b"GIF") {
        "image/gif".to_string()
    } else if bytes.starts_with(b"WEBP") || (bytes.len() > 12 && &bytes[8..12] == b"WEBP") {
        "image/webp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

/// Simple base64 encoding (to avoid adding a crate dependency).
/// Encodes a byte slice into a base64 String.
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    let chunks = data.chunks(3);

    for chunk in chunks {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

// =============================================================================
// Play history commands
// =============================================================================

#[tauri::command]
#[specta::specta]
pub fn clear_play_history(history: State<'_, PlayHistoryWriter>) -> Result<(), AppError> {
    history.clear_history().map_err(AppError::Database)
}

#[tauri::command]
#[specta::specta]
pub fn get_recently_played(db: State<'_, Database>) -> Result<Vec<Track>, AppError> {
    db.get_recently_played(20).map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
pub fn get_top_artists_played(db: State<'_, Database>) -> Result<Vec<TopArtist>, AppError> {
    db.get_top_artists_played(8).map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
pub fn get_recently_added_tracks(db: State<'_, Database>) -> Result<Vec<Track>, AppError> {
    db.get_recently_added_tracks(20).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::{
        FULLSCREEN_ARTWORK_SIZE, MAX_SCAN_ERROR_DETAILS, STANDARD_ARTWORK_SIZE, ScanIssue,
        ScanSummary, THUMBNAIL_ARTWORK_SIZE, artwork_size_from_query, build_reveal_command,
        finish_scan, normalize_windows_explorer_path, prune_scanned_roots, read_bounded_artwork,
        resize_artwork, resolve_track_path_to_reveal, run_bounded_scan_tasks, scan_folders,
        scan_library_inner, scan_library_inner_with_folders, scan_worker_count,
        windows_explorer_raw_arg,
    };
    use crate::error::AppError;
    use crate::library::database::Database;
    use crate::models::{ScanPayload, ScanRootOutcome, ScanRootStatus, ScanStatus, Track};
    use image::{DynamicImage, ImageFormat};
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn write_valid_wav(path: &Path) {
        let sample_rate = 8_000u32;
        let data = vec![128u8; 800];
        let mut wav = Vec::with_capacity(44 + data.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        std::fs::write(path, wav).unwrap();
    }

    fn add_library_root(db: &Database, root: &Path) {
        db.add_library_folder(root.to_string_lossy().as_ref())
            .unwrap();
    }

    fn insert_rejection_trigger(db_path: &Path) {
        let conn = rusqlite::Connection::open(db_path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_track_insert
             BEFORE INSERT ON tracks
             BEGIN SELECT RAISE(ABORT, 'forced upsert failure'); END;",
        )
        .unwrap();
    }

    fn delete_rejection_trigger(db_path: &Path, track_id: &str) {
        let conn = rusqlite::Connection::open(db_path).unwrap();
        let escaped_track_id = track_id.replace('\'', "''");
        conn.execute_batch(&format!(
            "CREATE TRIGGER reject_track_delete
             BEFORE DELETE ON tracks WHEN OLD.id = '{escaped_track_id}'
             BEGIN SELECT RAISE(ABORT, 'forced prune failure'); END"
        ))
        .unwrap();
    }

    fn track_for_path(id: &str, path: &Path) -> Track {
        let file_metadata = std::fs::metadata(path).ok();
        let file_size = file_metadata
            .as_ref()
            .map(|metadata| metadata.len() as i64)
            .unwrap_or(0);
        let file_modified_unix = file_metadata
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        Track {
            id: id.to_string(),
            title: format!("Track {id}"),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Artist".to_string(),
            genre: "Unknown".to_string(),
            year: None,
            track_number: None,
            disc_number: None,
            duration_secs: 0.0,
            file_path: path.to_string_lossy().into_owned(),
            file_size,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn root_outcome<'a>(payload: &'a ScanPayload, path: &str) -> &'a ScanRootOutcome {
        payload
            .root_outcomes
            .iter()
            .find(|outcome| outcome.path == path)
            .unwrap_or_else(|| panic!("missing scan outcome for root {path}"))
    }

    fn status_name(status: ScanStatus) -> &'static str {
        match status {
            ScanStatus::Scanning => "scanning",
            ScanStatus::Processing => "processing",
            ScanStatus::Complete => "complete",
            ScanStatus::Error => "error",
        }
    }

    fn test_track(path: &Path) -> Track {
        Track {
            id: "track-id".to_string(),
            title: "Test Track".to_string(),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Unknown".to_string(),
            year: None,
            track_number: None,
            disc_number: None,
            duration_secs: 180.0,
            file_path: path.to_string_lossy().into_owned(),
            file_size: 0,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2026-10-18T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn reveal_lookup_resolves_only_a_known_track_id() {
        let db = Database::open(":memory:").unwrap();
        let path = std::env::temp_dir().join(format!("viby-reveal-{}.flac", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"audio").unwrap();
        db.upsert_track(&test_track(&path)).unwrap();

        let resolved = resolve_track_path_to_reveal(&db, "track-id").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&path).unwrap());
        assert!(resolve_track_path_to_reveal(&db, "untrusted-path").is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reveal_lookup_reports_missing_track_files() {
        let db = Database::open(":memory:").unwrap();
        let path = std::env::temp_dir().join(format!("viby-missing-{}.flac", uuid::Uuid::new_v4()));
        db.upsert_track(&test_track(&path)).unwrap();

        assert!(resolve_track_path_to_reveal(&db, "track-id").is_err());
    }

    #[test]
    fn reveal_command_keeps_paths_as_arguments() {
        let path = Path::new("/music/Artist & Album/01 - Track.flac");
        let command = build_reveal_command(path).unwrap();
        let program = command.get_program().to_string_lossy();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        #[cfg(target_os = "macos")]
        assert_eq!(
            (program.as_ref(), args),
            ("open", vec!["-R".to_string(), path.display().to_string()])
        );
        #[cfg(target_os = "windows")]
        assert_eq!(program.as_ref(), "explorer.exe");
        #[cfg(target_os = "linux")]
        assert_eq!(
            (program.as_ref(), args),
            (
                "xdg-open",
                vec![path.parent().unwrap().display().to_string()]
            )
        );
    }

    #[test]
    fn windows_reveal_argument_quotes_the_path_as_one_raw_argument() {
        let path = Path::new(r"C:\Music Library\Artist & Album\01 - Track.flac");
        let argument = windows_explorer_raw_arg(path.as_os_str());
        assert_eq!(
            argument.to_string_lossy(),
            r#"/select,"C:\Music Library\Artist & Album\01 - Track.flac""#
        );
    }

    #[test]
    fn windows_explorer_path_normalization_handles_verbatim_drive_and_unc_paths() {
        let drive = r"\\?\C:\Music Library\Track.flac";
        let normalized_drive =
            normalize_windows_explorer_path(&drive.encode_utf16().collect::<Vec<_>>());
        assert_eq!(
            String::from_utf16(&normalized_drive).unwrap(),
            r"C:\Music Library\Track.flac"
        );

        let unc = r"\\?\UNC\server\share\Music Library\Track.flac";
        let normalized_unc =
            normalize_windows_explorer_path(&unc.encode_utf16().collect::<Vec<_>>());
        assert_eq!(
            String::from_utf16(&normalized_unc).unwrap(),
            r"\\server\share\Music Library\Track.flac"
        );
    }

    #[test]
    fn windows_explorer_path_normalization_preserves_regular_paths() {
        let path = r"C:\Music Library\Track.flac";
        let normalized = normalize_windows_explorer_path(&path.encode_utf16().collect::<Vec<_>>());
        assert_eq!(String::from_utf16(&normalized).unwrap(), path);
    }

    #[test]
    fn scan_workers_are_bounded() {
        assert_eq!(scan_worker_count(1), 1);
        assert_eq!(scan_worker_count(8), 4);
    }

    #[test]
    fn scan_workers_report_fast_results_without_exceeding_the_bound() {
        let fast_result_reported = std::sync::Arc::new(AtomicBool::new(false));
        let slow_worker_started = std::sync::Arc::new(AtomicBool::new(false));
        let worker_count = std::sync::Arc::new(AtomicUsize::new(0));
        let max_workers = std::sync::Arc::new(AtomicUsize::new(0));
        let results = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        let worker_fast_reported = std::sync::Arc::clone(&fast_result_reported);
        let worker_slow_started = std::sync::Arc::clone(&slow_worker_started);
        let worker_active = std::sync::Arc::clone(&worker_count);
        let worker_max = std::sync::Arc::clone(&max_workers);
        let worker = move |name: &'static str| {
            let active = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
            worker_max.fetch_max(active, Ordering::SeqCst);
            if name == "slow" {
                worker_slow_started.store(true, Ordering::SeqCst);
                let deadline = Instant::now() + Duration::from_secs(1);
                while !worker_fast_reported.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1));
                }
            } else if name == "fast" {
                let deadline = Instant::now() + Duration::from_secs(1);
                while !worker_slow_started.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            if name == "failure" {
                worker_active.fetch_sub(1, Ordering::SeqCst);
                return Err("fixture metadata failure".to_string());
            }
            worker_active.fetch_sub(1, Ordering::SeqCst);
            Ok(name)
        };

        let jobs = ["slow", "fast", "failure", "last"]
            .into_iter()
            .map(|name| (name.to_string(), name))
            .collect::<Vec<_>>();
        let result_sink = std::sync::Arc::clone(&results);
        let callback_fast_reported = std::sync::Arc::clone(&fast_result_reported);

        tauri::async_runtime::block_on(run_bounded_scan_tasks(
            jobs,
            2,
            worker,
            move |path, result| {
                if path == "fast" {
                    callback_fast_reported.store(true, Ordering::SeqCst);
                }
                result_sink.lock().unwrap().push((path, result));
            },
        ));

        let results = results.lock().unwrap();
        assert_eq!(results.len(), 4);
        assert_eq!(results[0].0, "fast");
        assert_eq!(max_workers.load(Ordering::SeqCst), 2);
        assert!(results.iter().any(|(path, result)| {
            path == "failure" && result.as_ref().unwrap_err() == "fixture metadata failure"
        }));
        assert!(
            results
                .iter()
                .any(|(path, result)| path == "last" && result.is_ok())
        );
    }

    #[test]
    fn cancelling_scan_workers_does_not_submit_the_queued_files() {
        let started = std::sync::Arc::new(AtomicUsize::new(0));
        let worker_started = std::sync::Arc::clone(&started);
        let jobs = (0..8)
            .map(|index| (format!("file-{index}"), index))
            .collect::<Vec<_>>();
        let result = tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                Duration::from_millis(10),
                run_bounded_scan_tasks(
                    jobs,
                    2,
                    move |index| {
                        worker_started.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        Ok(index)
                    },
                    |_, _| {},
                ),
            )
            .await
        });

        assert!(result.is_err());
        std::thread::sleep(Duration::from_millis(120));
        assert!(started.load(Ordering::SeqCst) <= 2);
    }

    #[test]
    fn metadata_failure_preserves_tracks_in_affected_root() {
        let db = Database::open(":memory:").unwrap();
        let track = Track {
            id: "incomplete-scan".to_string(),
            title: "Track".to_string(),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Artist".to_string(),
            genre: "Unknown".to_string(),
            year: None,
            track_number: None,
            disc_number: None,
            duration_secs: 0.0,
            file_path: "/music/deleted.mp3".to_string(),
            file_size: 1,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        };
        db.upsert_track(&track).unwrap();

        let scanned_roots = vec![("/music".to_string(), vec!["/music/present.mp3".to_string()])];
        assert_eq!(
            prune_scanned_roots(
                &db,
                &scanned_roots,
                &[],
                &[ScanIssue {
                    path: "/music/unreadable.mp3".to_string(),
                    error: "fixture failure".to_string(),
                }],
            )
            .unwrap(),
            0
        );
        assert!(db.get_track(&track.id).unwrap().is_some());
    }

    #[test]
    fn scan_folders_keeps_successful_roots_when_another_root_fails() {
        let root = std::env::temp_dir().join(format!("viby-scan-ok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let audio_path = root.join("present.mp3");
        std::fs::write(&audio_path, b"audio fixture").unwrap();
        let unavailable = root.with_file_name(format!(
            "{}-unavailable",
            root.file_name().unwrap().to_string_lossy()
        ));
        let folders = vec![
            root.to_string_lossy().into_owned(),
            unavailable.to_string_lossy().into_owned(),
        ];

        let discovery = scan_folders(&folders);

        assert_eq!(discovery.scanned_roots.len(), 1);
        assert_eq!(
            discovery.files,
            vec![audio_path.to_string_lossy().into_owned()]
        );
        assert_eq!(discovery.folder_errors.len(), 1);
        assert_eq!(discovery.folder_errors[0].path, folders[1]);
        assert!(!discovery.folder_errors[0].error.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_lifecycle_reports_real_root_and_metadata_outcomes_conservatively() {
        let base =
            std::env::temp_dir().join(format!("viby-scan-lifecycle-{}", uuid::Uuid::new_v4()));
        let healthy_root = base.join("healthy");
        let partial_root = base.join("partial");
        let empty_child_root = base.join("empty-child");
        let unavailable_root = base.join("unavailable");
        let empty_child = empty_child_root.join("last-audio-directory");
        std::fs::create_dir_all(&healthy_root).unwrap();
        std::fs::create_dir_all(&partial_root).unwrap();
        std::fs::create_dir_all(&empty_child).unwrap();

        let unchanged_healthy = healthy_root.join("known.mp3");
        let new_healthy = healthy_root.join("new.wav");
        let corrupt_audio = partial_root.join("corrupt.mp3");
        let unchanged_empty_child_root = empty_child_root.join("known.mp3");
        std::fs::write(&unchanged_healthy, b"unchanged scan fixture").unwrap();
        write_valid_wav(&new_healthy);
        std::fs::write(&corrupt_audio, b"not a readable audio file").unwrap();
        std::fs::write(&unchanged_empty_child_root, b"unchanged scan fixture").unwrap();

        let database = Database::open(":memory:").unwrap();
        for root in [
            &healthy_root,
            &partial_root,
            &empty_child_root,
            &unavailable_root,
        ] {
            database
                .add_library_folder(root.to_string_lossy().as_ref())
                .unwrap();
        }
        let unchanged_healthy_track = track_for_path("unchanged-healthy", &unchanged_healthy);
        let unchanged_empty_track =
            track_for_path("unchanged-empty-root", &unchanged_empty_child_root);
        let stale_healthy = track_for_path("stale-healthy", &healthy_root.join("removed.mp3"));
        let stale_partial = track_for_path("stale-partial", &partial_root.join("removed.mp3"));
        let stale_empty_child = track_for_path(
            "stale-empty-child",
            &empty_child.join("last-file-removed.mp3"),
        );
        for track in [
            &unchanged_healthy_track,
            &unchanged_empty_track,
            &stale_healthy,
            &stale_partial,
            &stale_empty_child,
        ] {
            database.upsert_track(track).unwrap();
        }
        let mut summary = ScanSummary::default();
        let mut progress_events = Vec::new();
        let outcome = tauri::async_runtime::block_on(scan_library_inner(
            &database,
            &mut summary,
            |summary, status| {
                progress_events.push((
                    status_name(status).to_string(),
                    summary.payload(status, None, false),
                ));
            },
        ));

        assert!(outcome.is_ok());
        assert_eq!(summary.total_files, 4);
        assert_eq!(summary.processed_files, 4);
        assert_eq!(summary.new_tracks, 1);
        assert_eq!(summary.changed_tracks, 0);
        assert_eq!(summary.file_errors.len(), 1);
        assert_eq!(
            summary.file_errors[0].path,
            corrupt_audio.to_string_lossy().into_owned()
        );
        assert_eq!(summary.folder_errors.len(), 1);
        assert_eq!(
            summary.folder_errors[0].path,
            unavailable_root.to_string_lossy().into_owned()
        );
        assert_eq!(summary.removed_tracks, 1);
        assert!(
            progress_events
                .iter()
                .any(|(status, _)| status == "scanning")
        );
        assert!(
            progress_events
                .iter()
                .any(|(status, _)| status == "processing")
        );

        let mut terminal_events = Vec::new();
        let terminal = finish_scan(&summary, outcome, |name, payload| {
            terminal_events.push((name.as_str().to_string(), payload.clone()));
        })
        .unwrap();
        assert_eq!(terminal_events.len(), 2);
        assert_eq!(terminal_events[0].0, "scan-progress");
        assert_eq!(terminal_events[1].0, "scan-complete");
        assert!(terminal.partial_success);

        let healthy_path = healthy_root.to_string_lossy();
        let partial_path = partial_root.to_string_lossy();
        let empty_child_root_path = empty_child_root.to_string_lossy();
        let unavailable_path = unavailable_root.to_string_lossy();
        assert_eq!(
            root_outcome(&terminal, &healthy_path).status,
            ScanRootStatus::Complete
        );
        assert_eq!(
            root_outcome(&terminal, &partial_path).status,
            ScanRootStatus::Partial
        );
        assert_eq!(root_outcome(&terminal, &partial_path).skipped_files, 1);
        assert!(root_outcome(&terminal, &partial_path).pruning_skipped);
        assert_eq!(
            root_outcome(&terminal, &empty_child_root_path).protected_empty_subtrees,
            1
        );
        assert_eq!(
            root_outcome(&terminal, &unavailable_path).status,
            ScanRootStatus::Error
        );
        assert!(root_outcome(&terminal, &unavailable_path).pruning_skipped);

        assert!(database.get_track(&stale_healthy.id).unwrap().is_none());
        assert!(database.get_track(&stale_partial.id).unwrap().is_some());
        assert!(database.get_track(&stale_empty_child.id).unwrap().is_some());
        assert!(
            database
                .get_track(&unchanged_healthy_track.id)
                .unwrap()
                .is_some()
        );
        assert!(
            database
                .get_track(&unchanged_empty_track.id)
                .unwrap()
                .is_some()
        );
        assert!(
            database
                .get_track_by_path(&new_healthy.to_string_lossy())
                .unwrap()
                .is_some()
        );
        drop(database);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn overlapping_roots_import_once_and_keep_the_same_track_and_relations_on_reversed_rescan() {
        use crate::models::{Playlist, TrackEqOverride};

        let base = std::env::temp_dir().join(format!("viby-scan-overlap-{}", uuid::Uuid::new_v4()));
        let parent_root = base.join("library");
        let nested_root = parent_root.join("nested");
        std::fs::create_dir_all(&nested_root).unwrap();
        let wav = nested_root.join("new.wav");
        write_valid_wav(&wav);

        let database = Database::open(":memory:").unwrap();
        add_library_root(&database, &parent_root);
        add_library_root(&database, &nested_root);
        let parent = parent_root.to_string_lossy().into_owned();
        let nested = nested_root.to_string_lossy().into_owned();

        let mut first_summary = ScanSummary::default();
        let first_outcome = tauri::async_runtime::block_on(scan_library_inner_with_folders(
            &database,
            &mut first_summary,
            vec![parent.clone(), nested.clone()],
            |_, _| {},
        ));
        let first = finish_scan(&first_summary, first_outcome, |_, _| {}).unwrap();

        assert_eq!(first.status, ScanStatus::Complete);
        assert_eq!(first.total_files, 1);
        assert_eq!(first.processed_files, 1);
        assert_eq!(first.new_tracks, 1);
        assert_eq!(root_outcome(&first, &parent).discovered_files, 1);
        assert_eq!(root_outcome(&first, &nested).discovered_files, 1);
        assert_eq!(database.get_all_file_paths().unwrap().len(), 1);
        let first_track = database
            .get_track_by_path(&wav.to_string_lossy())
            .unwrap()
            .unwrap();
        let track_id = first_track.id.clone();

        database
            .create_playlist(&Playlist {
                id: "overlap-playlist".to_string(),
                name: "Keep scanned track".to_string(),
                track_count: 0,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            })
            .unwrap();
        database
            .add_tracks_to_playlist("overlap-playlist", std::slice::from_ref(&track_id))
            .unwrap();
        database.record_play(&track_id).unwrap();
        database
            .save_track_eq_override(&TrackEqOverride {
                track_id: track_id.clone(),
                enabled: true,
                preamp_db: -1.0,
                gains: vec![0.0; 10],
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            })
            .unwrap();

        let mut reversed_summary = ScanSummary::default();
        let reversed_outcome = tauri::async_runtime::block_on(scan_library_inner_with_folders(
            &database,
            &mut reversed_summary,
            vec![nested.clone(), parent.clone()],
            |_, _| {},
        ));
        let reversed = finish_scan(&reversed_summary, reversed_outcome, |_, _| {}).unwrap();

        assert_eq!(reversed.status, ScanStatus::Complete);
        assert_eq!(reversed.total_files, 1);
        assert_eq!(reversed.processed_files, 1);
        assert_eq!(reversed.new_tracks, 0);
        assert_eq!(reversed.changed_tracks, 0);
        let remaining_paths = database.get_all_file_paths().unwrap();
        assert_eq!(remaining_paths.len(), 1);
        let rescanned_track = database
            .get_track_by_path(&wav.to_string_lossy())
            .unwrap()
            .unwrap();
        assert_eq!(rescanned_track.id, track_id);
        assert_eq!(
            database
                .get_playlist_tracks("overlap-playlist")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(database.get_recently_played(10).unwrap().len(), 1);
        assert!(
            database
                .get_track_eq_override(&rescanned_track.id)
                .unwrap()
                .is_some()
        );

        drop(database);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn overlapping_roots_import_once_when_nested_root_is_first() {
        let base = std::env::temp_dir().join(format!(
            "viby-scan-overlap-reversed-{}",
            uuid::Uuid::new_v4()
        ));
        let parent_root = base.join("library");
        let nested_root = parent_root.join("nested");
        std::fs::create_dir_all(&nested_root).unwrap();
        let wav = nested_root.join("new.wav");
        write_valid_wav(&wav);

        let database = Database::open(":memory:").unwrap();
        add_library_root(&database, &parent_root);
        add_library_root(&database, &nested_root);
        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner_with_folders(
            &database,
            &mut summary,
            vec![
                nested_root.to_string_lossy().into_owned(),
                parent_root.to_string_lossy().into_owned(),
            ],
            |_, _| {},
        ));
        let terminal = finish_scan(&summary, outcome, |_, _| {}).unwrap();

        assert_eq!(terminal.status, ScanStatus::Complete);
        assert_eq!(terminal.total_files, 1);
        assert_eq!(terminal.processed_files, 1);
        assert_eq!(terminal.new_tracks, 1);
        assert_eq!(database.get_all_file_paths().unwrap().len(), 1);
        let imported = database
            .get_track_by_path(&wav.to_string_lossy())
            .unwrap()
            .unwrap();
        assert!(!imported.id.is_empty());

        drop(database);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn overlapping_partial_scan_keeps_root_pruning_protection_and_committed_counts() {
        let base = std::env::temp_dir().join(format!(
            "viby-scan-overlap-partial-{}",
            uuid::Uuid::new_v4()
        ));
        let parent_root = base.join("library");
        let nested_root = parent_root.join("nested");
        let empty_child = nested_root.join("empty-mount");
        std::fs::create_dir_all(&empty_child).unwrap();
        let wav = nested_root.join("new.wav");
        let corrupt = nested_root.join("corrupt.mp3");
        write_valid_wav(&wav);
        std::fs::write(&corrupt, b"invalid audio fixture").unwrap();

        let database = Database::open(":memory:").unwrap();
        add_library_root(&database, &parent_root);
        add_library_root(&database, &nested_root);
        let stale_nested = track_for_path("stale-overlap", &nested_root.join("removed.mp3"));
        let stale_empty = track_for_path("stale-empty-mount", &empty_child.join("removed.mp3"));
        database.upsert_track(&stale_nested).unwrap();
        database.upsert_track(&stale_empty).unwrap();

        let parent = parent_root.to_string_lossy().into_owned();
        let nested = nested_root.to_string_lossy().into_owned();
        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner_with_folders(
            &database,
            &mut summary,
            vec![parent.clone(), nested.clone()],
            |_, _| {},
        ));
        let terminal = finish_scan(&summary, outcome, |_, _| {}).unwrap();

        assert_eq!(terminal.status, ScanStatus::Complete);
        assert!(terminal.partial_success);
        assert_eq!(terminal.total_files, 2);
        assert_eq!(terminal.processed_files, 2);
        assert_eq!(terminal.new_tracks, 1);
        assert_eq!(terminal.skipped_files, 1);
        assert_eq!(terminal.file_errors.len(), 1);
        assert_eq!(terminal.file_errors[0].path, corrupt.to_string_lossy());
        for root in [&parent, &nested] {
            let outcome = root_outcome(&terminal, root);
            assert_eq!(outcome.status, ScanRootStatus::Partial);
            assert_eq!(outcome.skipped_files, 1);
            assert!(outcome.pruning_skipped);
            assert!(outcome.protected_empty_subtrees > 0);
        }
        assert!(database.get_track(&stale_nested.id).unwrap().is_some());
        assert!(database.get_track(&stale_empty.id).unwrap().is_some());
        assert!(
            database
                .get_track_by_path(&wav.to_string_lossy())
                .unwrap()
                .is_some()
        );
        assert_eq!(database.get_all_file_paths().unwrap().len(), 3);

        drop(database);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn empty_configuration_completes_with_one_terminal_result() {
        let database = Database::open(":memory:").unwrap();
        let mut summary = ScanSummary::default();
        let outcome =
            tauri::async_runtime::block_on(scan_library_inner(&database, &mut summary, |_, _| {}));
        let mut events = Vec::new();
        let terminal = finish_scan(&summary, outcome, |name, payload| {
            events.push((name.as_str().to_string(), payload.clone()));
        })
        .unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "scan-progress");
        assert_eq!(events[1].0, "scan-complete");
        assert_eq!(events[0].1.status, ScanStatus::Complete);
        assert_eq!(events[1].1.status, ScanStatus::Complete);
        assert_eq!(
            terminal.message.as_deref(),
            Some("No library folders configured. Add a folder first.")
        );
        assert_eq!(terminal.total_tracks, Some(0));
        assert!(terminal.root_outcomes.is_empty());
    }

    #[test]
    fn empty_root_completes_without_pruning_existing_tracks() {
        let base = std::env::temp_dir().join(format!("viby-scan-empty-{}", uuid::Uuid::new_v4()));
        let root = base.join("empty");
        std::fs::create_dir_all(&root).unwrap();
        let database = Database::open(base.join("library.sqlite")).unwrap();
        add_library_root(&database, &root);
        let stale = track_for_path("stale-empty", &root.join("removed.mp3"));
        database.upsert_track(&stale).unwrap();
        let database_owner = database;

        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner(
            &database_owner,
            &mut summary,
            |_, _| {},
        ));
        let terminal = finish_scan(&summary, outcome, |_, _| {}).unwrap();

        assert_eq!(terminal.status, ScanStatus::Complete);
        let root_result = root_outcome(&terminal, &root.to_string_lossy());
        assert_eq!(root_result.status, ScanRootStatus::Complete);
        assert!(root_result.pruning_skipped);
        assert_eq!(root_result.protected_empty_subtrees, 1);
        assert_eq!(terminal.removed_tracks, 0);
        assert!(database_owner.get_track(&stale.id).unwrap().is_some());
        drop(database_owner);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn all_roots_failing_emits_terminal_error_without_pruning() {
        let base = std::env::temp_dir().join(format!("viby-scan-offline-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("offline");
        let database = Database::open(base.join("library.sqlite")).unwrap();
        add_library_root(&database, &root);
        let stale = track_for_path("stale-offline", &root.join("removed.mp3"));
        database.upsert_track(&stale).unwrap();
        let database_owner = database;

        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner(
            &database_owner,
            &mut summary,
            |_, _| {},
        ));
        let mut events = Vec::new();
        let terminal = finish_scan(&summary, outcome, |name, payload| {
            events.push((name.as_str().to_string(), payload.clone()));
        });

        assert!(terminal.is_err());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "scan-progress");
        assert_eq!(events[1].0, "scan-complete");
        assert_eq!(events[1].1.status, ScanStatus::Error);
        assert_eq!(events[1].1.failed_folders, 1);
        assert_eq!(
            root_outcome(&events[1].1, &root.to_string_lossy()).status,
            ScanRootStatus::Error
        );
        assert!(database_owner.get_track(&stale.id).unwrap().is_some());
        drop(database_owner);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn failed_upsert_reports_only_committed_track_counts() {
        let base = std::env::temp_dir().join(format!("viby-scan-upsert-{}", uuid::Uuid::new_v4()));
        let root = base.join("music");
        std::fs::create_dir_all(&root).unwrap();
        let wav = root.join("new.wav");
        write_valid_wav(&wav);
        let db_path = base.join("library.sqlite");
        let database = Database::open(&db_path).unwrap();
        add_library_root(&database, &root);
        insert_rejection_trigger(&db_path);
        let database_owner = database;

        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner(
            &database_owner,
            &mut summary,
            |_, _| {},
        ));
        let mut events = Vec::new();
        let terminal = finish_scan(&summary, outcome, |name, payload| {
            events.push((name.as_str().to_string(), payload.clone()));
        });

        assert!(terminal.is_err());
        assert_eq!(events.len(), 2);
        let terminal_payload = &events[1].1;
        assert_eq!(terminal_payload.status, ScanStatus::Error);
        assert_eq!(terminal_payload.new_tracks, 0);
        assert_eq!(terminal_payload.changed_tracks, 0);
        assert!(
            database_owner
                .get_track_by_path(&wav.to_string_lossy())
                .unwrap()
                .is_none()
        );
        drop(database_owner);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn prune_failure_reports_committed_upsert_and_retains_stale_track() {
        let base = std::env::temp_dir().join(format!("viby-scan-prune-{}", uuid::Uuid::new_v4()));
        let root = base.join("music");
        std::fs::create_dir_all(&root).unwrap();
        let wav = root.join("new.wav");
        write_valid_wav(&wav);
        let db_path = base.join("library.sqlite");
        let database = Database::open(&db_path).unwrap();
        add_library_root(&database, &root);
        let stale = track_for_path("stale-prune", &root.join("removed.mp3"));
        database.upsert_track(&stale).unwrap();
        delete_rejection_trigger(&db_path, &stale.id);
        let database_owner = database;

        let mut summary = ScanSummary::default();
        let outcome = tauri::async_runtime::block_on(scan_library_inner(
            &database_owner,
            &mut summary,
            |_, _| {},
        ));
        let mut events = Vec::new();
        let terminal = finish_scan(&summary, outcome, |name, payload| {
            events.push((name.as_str().to_string(), payload.clone()));
        });

        assert!(terminal.is_err());
        assert_eq!(events.len(), 2);
        let terminal_payload = &events[1].1;
        assert_eq!(terminal_payload.status, ScanStatus::Error);
        assert_eq!(terminal_payload.new_tracks, 1);
        assert!(
            database_owner
                .get_track_by_path(&wav.to_string_lossy())
                .unwrap()
                .is_some()
        );
        assert!(database_owner.get_track(&stale.id).unwrap().is_some());
        drop(database_owner);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn successful_partial_scan_and_fatal_scan_both_emit_terminal_events() {
        let mut summary = ScanSummary {
            total_files: 3,
            processed_files: 3,
            new_tracks: 1,
            folder_errors: vec![ScanIssue {
                path: "/offline/music".to_string(),
                error: "unavailable root".to_string(),
            }],
            file_errors: vec![ScanIssue {
                path: "/music/bad.mp3".to_string(),
                error: "unsupported file".to_string(),
            }],
            ..ScanSummary::default()
        };
        let mut events = Vec::new();
        let result = finish_scan(&summary, Ok(()), |name, payload| {
            events.push((name.as_str().to_string(), payload.clone()));
        })
        .unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "scan-progress");
        assert_eq!(events[1].0, "scan-complete");
        assert_eq!(result.status, ScanStatus::Complete);
        assert!(result.partial_success);
        assert_eq!(result.skipped_files, 1);
        assert_eq!(result.failed_folders, 1);
        assert_eq!(result.file_errors[0].path, "/music/bad.mp3");
        assert_eq!(events[1].1, result);

        events.clear();
        summary.file_errors.clear();
        let error = AppError::Other("database read failed".to_string());
        assert!(
            finish_scan(&summary, Err(error), |name, payload| {
                events.push((name.as_str().to_string(), payload.clone()));
            })
            .is_err()
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1.status, ScanStatus::Error);
        assert_eq!(events[0].1.error.as_deref(), Some("database read failed"));
        assert_eq!(events[1].0, "scan-complete");
        assert!(!events[1].1.partial_success);
    }

    #[test]
    fn scan_terminal_error_details_are_bounded_but_counts_are_complete() {
        let summary = ScanSummary {
            file_errors: (0..MAX_SCAN_ERROR_DETAILS + 1)
                .map(|index| ScanIssue {
                    path: format!("/music/{index}.mp3"),
                    error: "fixture failure".to_string(),
                })
                .collect(),
            ..ScanSummary::default()
        };

        let payload = summary.payload(ScanStatus::Complete, None, true);

        assert_eq!(payload.skipped_files, MAX_SCAN_ERROR_DETAILS + 1);
        assert_eq!(payload.file_errors.len(), MAX_SCAN_ERROR_DETAILS);
        assert!(payload.error_details_truncated);
    }

    #[test]
    fn partial_scan_prunes_healthy_roots_and_preserves_failed_root() {
        let db = Database::open(":memory:").unwrap();
        let healthy = crate::models::Track {
            id: "stale-healthy".to_string(),
            title: "Stale healthy root".to_string(),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Artist".to_string(),
            genre: "Unknown".to_string(),
            year: None,
            track_number: None,
            disc_number: None,
            duration_secs: 0.0,
            file_path: "/healthy/deleted.mp3".to_string(),
            file_size: 1,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        };
        let failed = crate::models::Track {
            id: "stale-failed".to_string(),
            file_path: "/failed/deleted.mp3".to_string(),
            ..healthy.clone()
        };
        db.upsert_track(&healthy).unwrap();
        db.upsert_track(&failed).unwrap();
        let roots = vec![
            (
                "/healthy".to_string(),
                vec!["/healthy/present.mp3".to_string()],
            ),
            (
                "/failed".to_string(),
                vec!["/failed/unreadable.mp3".to_string()],
            ),
        ];

        let removed = prune_scanned_roots(
            &db,
            &roots,
            &[],
            &[ScanIssue {
                path: "/failed/unreadable.mp3".to_string(),
                error: "fixture failure".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(removed, 1);
        assert!(db.get_track(&healthy.id).unwrap().is_none());
        assert!(db.get_track(&failed.id).unwrap().is_some());
    }

    #[test]
    fn artwork_size_query_accepts_only_supported_sizes() {
        assert_eq!(artwork_size_from_query(None), STANDARD_ARTWORK_SIZE);
        assert_eq!(
            artwork_size_from_query(Some("size=128")),
            THUMBNAIL_ARTWORK_SIZE
        );
        assert_eq!(
            artwork_size_from_query(Some("size=768")),
            FULLSCREEN_ARTWORK_SIZE
        );
        assert_eq!(
            artwork_size_from_query(Some("size=7001")),
            STANDARD_ARTWORK_SIZE
        );
    }

    #[test]
    fn artwork_resize_bounds_longest_edge_without_upscaling() {
        let mut source = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(800, 400)
            .write_to(&mut source, ImageFormat::Png)
            .unwrap();
        let source = source.into_inner();

        let (resized, mime) = resize_artwork(&source, STANDARD_ARTWORK_SIZE).unwrap();
        let resized = image::load_from_memory(&resized).unwrap();
        assert_eq!((resized.width(), resized.height()), (384, 192));
        assert_eq!(mime, "image/png");

        let (unchanged, _) = resize_artwork(&source, 1024).unwrap();
        assert_eq!(unchanged, source);
    }

    #[test]
    fn artwork_reader_rejects_oversized_files() {
        let path =
            std::env::temp_dir().join(format!("viby-artwork-limit-{}.jpg", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::library::metadata::MAX_ARTWORK_BYTES as u64 + 1)
            .unwrap();

        assert!(read_bounded_artwork(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

pub mod audio;
pub mod commands;
pub mod error;
pub mod library;
pub mod models;
pub mod utils;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Manager, Listener, Emitter};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use library::database::Database;
use audio::player::AudioPlayer;
use audio::queue::PlaybackQueue;
use commands::playback::QueueState;
use commands::{library as lib_cmds, playback as play_cmds, playlist as list_cmds};
use models::PlaybackState;

/// In-process artwork cache keyed by album key ("album||album_artist").
/// Stores the base64-encoded image + MIME type so `get_track_artwork` never
/// re-reads the same audio file or folder image twice per session.
pub struct ArtworkCache {
    pub entries: HashMap<String, Option<(String, String)>>,
    pub order: VecDeque<String>,
    pub max_size: usize,
}

/// Guards against concurrent scan invocations.
/// `compare_exchange(false → true)` succeeds only when no scan is running.
pub struct ScanLock(pub AtomicBool);

impl ScanLock {
    pub fn try_acquire(&self) -> bool {
        self.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Get platform-specific AppData directory
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&app_data_dir).unwrap();

            // Initialize Database
            let db_path = app_data_dir.join("viby.db");
            let db = Database::open(db_path.to_str().unwrap()).expect("Failed to open or migrate database");

            // Initialize Audio Engine
            let player = AudioPlayer::new(app.handle().clone());
            let queue = PlaybackQueue::new();

            // Inject states into Tauri Manager so commands can access them
            app.manage(Mutex::new(db));
            app.manage(player);
            app.manage(QueueState(Mutex::new(queue)));
            app.manage(ScanLock(AtomicBool::new(false)));
            app.manage(Mutex::new(ArtworkCache {
                entries: HashMap::new(),
                order: VecDeque::new(),
                max_size: 300,
            }));

            // ── System tray ──────────────────────────────────────────────────
            let play_pause = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
            let next       = MenuItem::with_id(app, "next",       "Next",         true, None::<&str>)?;
            let previous   = MenuItem::with_id(app, "previous",   "Previous",     true, None::<&str>)?;
            let show       = MenuItem::with_id(app, "show",       "Show Viby",    true, None::<&str>)?;
            let quit       = MenuItem::with_id(app, "quit",       "Quit",         true, None::<&str>)?;

            let menu = Menu::with_items(app, &[
                &play_pause,
                &next,
                &previous,
                &PredefinedMenuItem::separator(app)?,
                &show,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // Left click → show window and emit tray-open so the
                    // frontend can activate mini player mode.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray-open", ());
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "play_pause" => {
                            let player = app.state::<AudioPlayer>();
                            if player.is_playing() {
                                player.pause();
                            } else {
                                player.resume();
                            }
                        }
                        "next" => {
                            let _ = play_cmds::next_track(
                                app.clone(),
                                Some(true),
                                app.state::<AudioPlayer>(),
                                app.state::<QueueState>(),
                                app.state::<Mutex<Database>>(),
                            );
                        }
                        "previous" => {
                            let _ = play_cmds::previous_track(
                                app.clone(),
                                Some(true),
                                app.state::<AudioPlayer>(),
                                app.state::<QueueState>(),
                                app.state::<Mutex<Database>>(),
                            );
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Update play/pause label whenever playback state changes
            app.listen("playback-state", move |event| {
                if let Ok(state) = serde_json::from_str::<PlaybackState>(event.payload()) {
                    let label = if state.is_playing { "Pause" } else { "Play" };
                    let _ = play_pause.set_text(label);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Library Commands
            lib_cmds::add_library_folder,
            lib_cmds::remove_library_folder,
            lib_cmds::get_library_folders,
            lib_cmds::scan_library,
            lib_cmds::get_all_tracks,
            lib_cmds::get_album_tracks,
            lib_cmds::get_albums,
            lib_cmds::get_artists,
            lib_cmds::get_genres,
            lib_cmds::search,
            lib_cmds::get_track_artwork,
            lib_cmds::get_recently_played,
            lib_cmds::get_top_artists_played,
            lib_cmds::get_recently_added_tracks,
            lib_cmds::clear_play_history,

            // Playback Commands
            play_cmds::play_track,
            play_cmds::pause,
            play_cmds::resume,
            play_cmds::stop,
            play_cmds::seek,
            play_cmds::set_volume,
            play_cmds::next_track,
            play_cmds::previous_track,
            play_cmds::set_shuffle,
            play_cmds::set_repeat,
            play_cmds::get_playback_state,
            play_cmds::get_queue,
            play_cmds::add_to_queue,
            play_cmds::add_tracks_to_queue,
            play_cmds::remove_from_queue,
            play_cmds::reorder_queue,
            play_cmds::clear_all,
            play_cmds::clear_up_next,
            play_cmds::clear_history,
            play_cmds::play_queue_index,

            // Playlist Commands
            list_cmds::create_playlist,
            list_cmds::delete_playlist,
            list_cmds::rename_playlist,
            list_cmds::get_playlists,
            list_cmds::get_playlist_tracks,
            list_cmds::add_to_playlist,
            list_cmds::remove_from_playlist,
            list_cmds::reorder_playlist
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

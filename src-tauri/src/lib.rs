pub mod audio;
pub mod autoeq;
pub mod commands;
pub mod embedded_curves;
pub mod error;
pub mod library;
pub mod models;
pub mod utils;

use audio::player::AudioPlayer;
use audio::queue::PlaybackQueue;
use commands::playback::QueueState;
use commands::{library as lib_cmds, playback as play_cmds, playlist as list_cmds};
use library::database::Database;
use models::PlaybackState;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager};

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
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct CloseToTrayState(pub AtomicBool);

fn get_app_data_dir() -> std::path::PathBuf {
    let identifier = "com.viby.app";
    // This runs before Tauri's setup hook, where `app.path()` is not yet
    // available. The environment-variable fallback follows the same platform
    // conventions Tauri uses later: APPDATA on Windows, Application Support on
    // macOS, and XDG_DATA_HOME/`.local/share` on Linux and other Unix desktops.
    // Windows
    if let Ok(appdata) = std::env::var("APPDATA") {
        let mut path = std::path::PathBuf::from(appdata);
        path.push(identifier);
        return path;
    }
    // macOS
    if cfg!(target_os = "macos")
        && let Ok(home) = std::env::var("HOME")
    {
        let mut path = std::path::PathBuf::from(home);
        path.push("Library");
        path.push("Application Support");
        path.push(identifier);
        return path;
    }
    // Linux/Unix
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let mut path = std::path::PathBuf::from(xdg);
        path.push(identifier);
        return path;
    }
    if let Ok(home) = std::env::var("HOME") {
        let mut path = std::path::PathBuf::from(home);
        path.push(".local");
        path.push("share");
        path.push(identifier);
        return path;
    }
    std::path::PathBuf::from(".")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Check GPU Acceleration setting before initializing webview/Tauri builder
    let app_data_dir = get_app_data_dir();
    let gpu_settings_path = app_data_dir.join("gpu_settings.json");
    let mut gpu_enabled = true; // Enabled by default!
    if gpu_settings_path.exists()
        && let Ok(content) = std::fs::read_to_string(&gpu_settings_path)
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&content)
        && let Some(enabled) = json.get("gpu_acceleration").and_then(|v| v.as_bool())
    {
        gpu_enabled = enabled;
    }

    if !gpu_enabled {
        // Disable GPU acceleration
        // For Linux (WebKit2GTK)
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        // For Windows (WebView2)
        unsafe {
            std::env::set_var(
                "TAURI_WEBVIEW_ADDITIONAL_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing",
            );
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = app_clone.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<CloseToTrayState>();
                if state.0.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Get platform-specific AppData directory
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&app_data_dir).unwrap();

            // Create target-reference folder in AppData directory if it doesn't exist
            let target_ref_dir = app_data_dir.join("target-reference");
            if !target_ref_dir.exists() {
                let _ = std::fs::create_dir_all(&target_ref_dir);
            }

            // Copy default target curves to app_data_dir/target-reference/ if they exist in source paths
            let mut source_candidates = vec![
                // CWD (dev mode)
                std::env::current_dir()
                    .map(|p| p.join("target-reference"))
                    .unwrap_or_default(),
                // Parent directory (dev mode, sub-project layout)
                std::env::current_dir()
                    .map(|p| p.join("../target-reference"))
                    .unwrap_or_default(),
                // Tauri bundled resources
                app.path()
                    .resolve("target-reference", tauri::path::BaseDirectory::Resource)
                    .unwrap_or_default(),
            ];
            // Linux package fallback (set by PKGBUILD package()). Bundled
            // resources and app data remain the primary cross-platform paths.
            #[cfg(target_os = "linux")]
            source_candidates.push(std::path::PathBuf::from("/usr/share/viby/target-reference"));

            if let Some(src_dir) = source_candidates
                .into_iter()
                .find(|p| p.exists() && p.is_dir())
                && let Ok(entries) = std::fs::read_dir(&src_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file()
                            && path.extension().and_then(|ext| ext.to_str()) == Some("txt")
                            && let Some(file_name) = path.file_name() {
                                let dest_path = target_ref_dir.join(file_name);
                                if !dest_path.exists() {
                                    let _ = std::fs::copy(&path, &dest_path);
                                }
                            }
                    }
                }

            // Initialize Database
            let db_path = app_data_dir.join("viby.db");
            let db = Database::open(db_path.to_str().unwrap())
                .expect("Failed to open or migrate database");

            // Initialize Audio Engine
            let player = AudioPlayer::new(app.handle().clone());
            let queue = PlaybackQueue::new();

            // Inject states into Tauri Manager so commands can access them
            app.manage(Mutex::new(db));
            app.manage(player);
            app.manage(QueueState(Mutex::new(queue)));

            // Initialize System Media Controls (MPRIS / SMTC). This integration
            // is optional at runtime: unsupported sessions, missing D-Bus/SMTC
            // services, or platform setup failures must not prevent playback.
            let config = souvlaki::PlatformConfig {
                dbus_name: "com.viby.app",
                display_name: "Viby",
                hwnd: None,
            };

            match souvlaki::MediaControls::new(config) {
                Ok(mut controls) => {
                    let app_handle = app.handle().clone();
                    if let Err(err) = controls.attach(move |event| {
                        let player = app_handle.state::<AudioPlayer>();
                        let queue = app_handle.state::<QueueState>();
                        let db = app_handle.state::<Mutex<Database>>();
                        let handle = app_handle.clone();

                        match event {
                            souvlaki::MediaControlEvent::Play => {
                                player.resume();
                            }
                            souvlaki::MediaControlEvent::Pause => {
                                player.pause();
                            }
                            souvlaki::MediaControlEvent::Toggle => {
                                if player.is_playing() {
                                    player.pause();
                                } else {
                                    player.resume();
                                }
                            }
                            souvlaki::MediaControlEvent::Next => {
                                let _ =
                                    play_cmds::next_track(handle, Some(true), player, queue, db);
                            }
                            souvlaki::MediaControlEvent::Previous => {
                                let _ = play_cmds::previous_track(
                                    handle,
                                    Some(true),
                                    player,
                                    queue,
                                    db,
                                );
                            }
                            souvlaki::MediaControlEvent::Stop => {
                                player.stop();
                            }
                            _ => {}
                        }
                    }) {
                        eprintln!("[Viby] System media controls unavailable: {err}");
                    } else {
                        app.manage(Mutex::new(controls));
                    }
                }
                Err(err) => {
                    eprintln!("[Viby] Failed to create system media controls: {err}");
                }
            }
            app.manage(ScanLock(AtomicBool::new(false)));
            app.manage(CloseToTrayState(AtomicBool::new(true)));
            app.manage(Mutex::new(ArtworkCache {
                entries: HashMap::new(),
                order: VecDeque::new(),
                max_size: 300,
            }));

            // ── System tray ──────────────────────────────────────────────────
            let mini_player =
                MenuItem::with_id(app, "mini_player", "Mini Player", true, None::<&str>)?;
            let play_pause =
                MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
            let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
            let previous = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Viby", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &mini_player,
                    &PredefinedMenuItem::separator(app)?,
                    &play_pause,
                    &next,
                    &previous,
                    &PredefinedMenuItem::separator(app)?,
                    &show,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                        | TrayIconEvent::DoubleClick { .. } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "mini_player" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray-open", ());
                    }
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
            play_cmds::set_eq,
            play_cmds::set_peq,
            play_cmds::set_eq_oversampling,
            play_cmds::set_eq_topology,
            play_cmds::export_peq,
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
            play_cmds::get_target_curves,
            play_cmds::import_target_curve,
            play_cmds::delete_target_curve,
            play_cmds::get_headphone_measurements,
            play_cmds::import_headphone_measurement,
            play_cmds::delete_headphone_measurement,
            play_cmds::read_text_file,
            autoeq::run_autoeq,
            // Playlist Commands
            list_cmds::create_playlist,
            list_cmds::delete_playlist,
            list_cmds::rename_playlist,
            list_cmds::get_playlists,
            list_cmds::get_playlist_tracks,
            list_cmds::add_to_playlist,
            list_cmds::remove_from_playlist,
            list_cmds::reorder_playlist,
            // GPU Settings Command
            play_cmds::set_gpu_acceleration,
            // Close to Tray Settings Command
            play_cmds::set_close_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

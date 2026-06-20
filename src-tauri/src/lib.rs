pub mod artwork_cache;
pub mod audio;
pub mod autoeq;
pub mod background_app;
pub mod commands;
pub mod discord;
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
use serde::{Deserialize, Serialize};
use models::PlaybackState;
use std::collections::{HashMap, VecDeque};
#[cfg(target_os = "windows")]
use std::ffi::c_void;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager};

/// In-process artwork cache keyed by album key ("album||album_artist").
/// Stores the raw image bytes + MIME type so `get_track_artwork` never
/// re-reads the same audio file or folder image twice per session.
pub struct ArtworkCache {
    pub entries: HashMap<String, Option<(Vec<u8>, String)>>,
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

pub struct DiscordRpcEnabled(pub AtomicBool);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct WindowSizeState {
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn system_media_controls_hwnd<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<*mut c_void> {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[Viby] System media controls unavailable: main window not found");
        return None;
    };
    match window.hwnd() {
        Ok(hwnd) => Some(hwnd.0 as *mut c_void),
        Err(err) => {
            eprintln!("[Viby] System media controls unavailable: failed to get HWND: {err}");
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn system_media_controls_hwnd<R: tauri::Runtime>(
    _app: &tauri::App<R>,
) -> Option<*mut std::ffi::c_void> {
    None
}

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

fn window_state_path() -> std::path::PathBuf {
    get_app_data_dir().join("window_state.json")
}

fn load_window_size() -> Option<WindowSizeState> {
    let path = window_state_path();
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_window_size(size: WindowSizeState) -> Result<(), String> {
    use std::fs::{create_dir_all, write};

    let path = window_state_path();
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(&size).map_err(|err| err.to_string())?;
    write(path, payload).map_err(|err| err.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn write_log_to_disk(log_content: String) -> Result<(), String> {
    use std::fs::{File, create_dir_all};
    use std::io::Write;

    let mut log_dir = get_app_data_dir();
    if let Err(e) = create_dir_all(&log_dir) {
        return Err(format!("Failed to create log directory: {e}"));
    }
    log_dir.push("viby_profiler.log");

    let mut file = File::create(&log_dir).map_err(|e| format!("Failed to create log file: {e}"))?;
    file.write_all(log_content.as_bytes())
        .map_err(|e| format!("Failed to write log file: {e}"))?;

    Ok(())
}

#[tauri::command]
fn set_discord_rpc_enabled(
    enabled: bool,
    rpc_enabled: tauri::State<DiscordRpcEnabled>,
    rpc: tauri::State<discord::DiscordRpcState>,
) {
    rpc_enabled.0.store(enabled, Ordering::SeqCst);
    if !enabled {
        discord::clear_presence(&rpc);
    }
}

#[tauri::command]
fn is_kde_desktop() -> bool {
    #[cfg(target_os = "linux")]
    {
        [
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "DESKTOP_SESSION",
        ]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .any(|value| value.to_ascii_lowercase().contains("kde"))
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::utils::setup_panic_hook();
    crate::utils::setup_crash_signal_handler();
    #[cfg(target_family = "unix")]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    // Check GPU Acceleration setting before initializing webview/Tauri builder
    let app_data_dir = get_app_data_dir();
    let gpu_settings_path = app_data_dir.join("gpu_settings.json");
    let mut gpu_enabled = !cfg!(target_os = "linux");
    if gpu_settings_path.exists()
        && let Ok(content) = std::fs::read_to_string(&gpu_settings_path)
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&content)
        && let Some(enabled) = json.get("gpu_acceleration").and_then(|v| v.as_bool())
    {
        gpu_enabled = enabled;
    }

    if !gpu_enabled {
        eprintln!("[Viby] GPU acceleration disabled for WebView.");
        // Disable GPU acceleration
        // For Linux (WebKit2GTK)
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // For Windows (WebView2)
        unsafe {
            std::env::set_var(
                "TAURI_WEBVIEW_ADDITIONAL_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing",
            );
        }
    } else {
        eprintln!("[Viby] GPU acceleration enabled for WebView.");
    }

    tauri::Builder::default()
        .register_uri_scheme_protocol("viby-artwork", |ctx, request| {
            let app = ctx.app_handle();
            let mut path = request.uri().path().trim_start_matches('/');
            if let Some(stripped) = path.strip_prefix("localhost/") {
                path = stripped;
            }

            // Get states
            let db = app.state::<Mutex<Database>>();
            let artwork_cache = app.state::<Mutex<ArtworkCache>>();

            match lib_cmds::fetch_raw_artwork(path, &db, &artwork_cache) {
                Ok(Some((bytes, mime))) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .header("Cache-Control", "public, max-age=31536000")
                    .body(bytes)
                    .unwrap(),
                _ => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .on_window_event(|window, event| {
            match event {
                // Honour the "Close button action" setting for every OS-level close
                // signal (ALT+F4, taskbar right-click → Close, etc.).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let close_to_tray = window
                        .app_handle()
                        .try_state::<CloseToTrayState>()
                        .map(|s| s.0.load(Ordering::SeqCst))
                        .unwrap_or(false);

                    if close_to_tray {
                        api.prevent_close();
                        let win = window.clone();
                        let _ = window.app_handle().run_on_main_thread(move || {
                            let _ = win.hide();
                        });
                    }
                }
                // Work around a Windows rendering glitch on resize.
                tauri::WindowEvent::Resized(_) => {
                    if let Ok(size) = window.inner_size()
                        && size.width >= 960
                        && size.height >= 680
                    {
                        let _ = save_window_size(WindowSizeState {
                            width: size.width,
                            height: size.height,
                        });
                    }

                    #[cfg(target_os = "windows")]
                    std::thread::sleep(std::time::Duration::from_nanos(1));
                }
                _ => {}
            }
        })
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
        .setup(|app| {
            // Get platform-specific AppData directory
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&app_data_dir).unwrap();

            // Apply native window vibrancy/Mica effects
            if let Some(_window) = app.get_webview_window("main") {
                if let Some(size) = load_window_size() {
                    let _ = _window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: size.height,
                    }));
                }

                #[cfg(target_os = "macos")]
                let _ = window_vibrancy::apply_vibrancy(
                    &_window,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    None,
                    Some(14.0),
                );

                #[cfg(target_os = "windows")]
                let _ = window_vibrancy::apply_mica(&_window, None);
            }

            // Create target-reference folder in AppData directory if it doesn't exist
            let target_ref_dir = app_data_dir.join("target-reference");
            if !target_ref_dir.exists() {
                let _ = std::fs::create_dir_all(&target_ref_dir);
            }

            // Copy default target curves to app_data_dir/target-reference/ if they exist in source paths
            #[allow(unused_mut)]
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
                && let Ok(entries) = std::fs::read_dir(&src_dir)
            {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && path.extension().and_then(|ext| ext.to_str()) == Some("txt")
                        && let Some(file_name) = path.file_name()
                    {
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
            let hwnd = system_media_controls_hwnd(app);
            #[cfg(target_os = "windows")]
            let config = if let Some(h) = hwnd {
                if !h.is_null() {
                    Some(souvlaki::PlatformConfig {
                        dbus_name: "com.viby.app",
                        display_name: "Viby",
                        desktop_entry: Some("viby"),
                        hwnd: Some(h),
                    })
                } else {
                    eprintln!("[Viby] System media controls skipped: HWND is NULL");
                    None
                }
            } else {
                eprintln!("[Viby] System media controls skipped: HWND is None");
                None
            };
            #[cfg(not(target_os = "windows"))]
            let config = Some(souvlaki::PlatformConfig {
                dbus_name: "com.viby.app",
                display_name: "Viby",
                desktop_entry: Some("viby"),
                hwnd,
            });

            if let Some(config) = config {
                match panic::catch_unwind(AssertUnwindSafe(|| souvlaki::MediaControls::new(config)))
                {
                    Ok(Ok(mut controls)) => {
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
                                    let _ = play_cmds::next_track(
                                        handle,
                                        Some(true),
                                        player,
                                        queue,
                                        db,
                                    );
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
                                souvlaki::MediaControlEvent::Raise => {
                                    let handle_clone = handle.clone();
                                    let _ = handle.run_on_main_thread(move || {
                                        if let Some(window) =
                                            handle_clone.get_webview_window("main")
                                        {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                        }
                                    });
                                }
                                _ => {}
                            }
                        }) {
                            eprintln!("[Viby] System media controls unavailable: {err}");
                        } else {
                            app.manage(Mutex::new(controls));
                        }
                    }
                    Ok(Err(err)) => {
                        eprintln!("[Viby] Failed to create system media controls: {err}");
                    }
                    Err(_) => {
                        eprintln!("[Viby] System media controls panicked during initialization");
                    }
                }
            }
            app.manage(ScanLock(AtomicBool::new(false)));
            app.manage(CloseToTrayState(AtomicBool::new(true)));
            app.manage(background_app::BackgroundAppState::new(true));
            app.manage(Mutex::new(ArtworkCache {
                entries: HashMap::new(),
                order: VecDeque::new(),
                max_size: 300,
            }));

            // Initialize Discord Rich Presence (optional — silently skipped if
            // Discord is not running or the client ID is not configured).
            // Disabled by default; the frontend syncs the persisted setting on startup.
            let discord_rpc = discord::DiscordRpcState(Mutex::new(discord::DiscordRpcInner {
                client: discord::try_connect(),
                last_connect_attempt: Some(std::time::Instant::now()),
                last_track_id: None,
                last_is_playing: false,
                last_position_baseline: None,
            }));
            app.manage(discord_rpc);
            app.manage(DiscordRpcEnabled(AtomicBool::new(false)));

            // Load persistent iTunes artwork cache from disk.
            let artwork_cache = artwork_cache::DiscordArtworkCache::load(
                app_data_dir.join("discord_artwork_cache.json"),
            );
            app.manage(artwork_cache);

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
                    &show,
                    &mini_player,
                    &PredefinedMenuItem::separator(app)?,
                    &play_pause,
                    &next,
                    &previous,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
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

            // Update play/pause label and Discord Rich Presence whenever playback state changes.
            // Artwork lookup is async (iTunes API); we show viby_logo immediately and update
            // Discord again once the fetch resolves.  A fetch-generation counter ensures only
            // the result for the most recently started fetch is applied — stale completions
            // for tracks the user has already skipped past are silently discarded.
            let discord_handle = app.handle().clone();
            let fetch_gen = Arc::new(std::sync::atomic::AtomicU64::new(0));
            app.listen("playback-state", move |event| {
                if let Ok(state) = serde_json::from_str::<PlaybackState>(event.payload()) {
                    let label = if state.is_playing { "Pause" } else { "Play" };
                    let _ = play_pause.set_text(label);

                    let track_title = state
                        .current_track
                        .as_ref()
                        .map(|t| t.title.clone())
                        .unwrap_or_else(|| "None".to_string());
                    crate::utils::log_rust_event(
                        "playback_state_listener",
                        &format!(
                            "Event: playing={}, track={}, pos={:.2}s",
                            state.is_playing, track_title, state.position_secs
                        ),
                    );

                    let handle_clone = discord_handle.clone();
                    let state_clone = state.clone();
                    let fetch_gen_clone = Arc::clone(&fetch_gen);

                    tauri::async_runtime::spawn_blocking(move || {
                        // Bail out early if Discord RPC is disabled in settings.
                        if let Some(enabled_state) = handle_clone.try_state::<DiscordRpcEnabled>() {
                            if !enabled_state.0.load(Ordering::SeqCst) {
                                return;
                            }
                        }

                        let Some(rpc) = handle_clone.try_state::<discord::DiscordRpcState>() else {
                            crate::utils::log_rust_event(
                                "playback_state_listener",
                                "DiscordRpcState not found in app state",
                            );
                            return;
                        };

                        let Some(track) = &state_clone.current_track else {
                            discord::update_presence(&rpc, &state_clone, None);
                            return;
                        };

                        let artist = track.artist.clone();
                        let album = track.album.clone();
                        let key = artwork_cache::cache_key(&artist, &album);

                        let cache = handle_clone.state::<artwork_cache::DiscordArtworkCache>();

                        match cache.get(&key) {
                            Some(cached_url) => {
                                // Cache hit (positive or negative TTL-valid) — use immediately.
                                discord::update_presence(&rpc, &state_clone, cached_url.as_deref());
                            }
                            None => {
                                // Not cached — show viby_logo now, fetch in background.
                                discord::update_presence(&rpc, &state_clone, None);

                                // Skip fetch if both fields are empty (no useful search term).
                                if artist.is_empty() && album.is_empty() {
                                    return;
                                }

                                let fetch_id = fetch_gen_clone
                                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                                    + 1;
                                let fetch_gen_clone2 = Arc::clone(&fetch_gen_clone);
                                let handle_clone2 = handle_clone.clone();
                                let state_clone2 = state_clone.clone();
                                let key_clone = key.clone();

                                tauri::async_runtime::spawn(async move {
                                    let url =
                                        artwork_cache::fetch_itunes_artwork(&artist, &album).await;

                                    // Discard if a newer fetch has already started (user skipped).
                                    if fetch_gen_clone2.load(std::sync::atomic::Ordering::SeqCst)
                                        != fetch_id
                                    {
                                        return;
                                    }

                                    // Persist: positive hits cached indefinitely, negative hits for 30 days.
                                    let cache =
                                        handle_clone2.state::<artwork_cache::DiscordArtworkCache>();
                                    cache.insert_and_save(key_clone, url.clone());

                                    let handle_clone3 = handle_clone2.clone();
                                    let state_clone3 = state_clone2.clone();
                                    let url_clone = url.clone();
                                    tauri::async_runtime::spawn_blocking(move || {
                                        if let Some(rpc) =
                                            handle_clone3.try_state::<discord::DiscordRpcState>()
                                        {
                                            discord::update_presence(
                                                &rpc,
                                                &state_clone3,
                                                url_clone.as_deref(),
                                            );
                                        }
                                    });
                                });
                            }
                        }
                    });
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
            play_cmds::skip_tracks,
            play_cmds::set_shuffle,
            play_cmds::set_repeat,
            play_cmds::get_playback_state,
            play_cmds::get_queue,
            play_cmds::add_to_queue,
            play_cmds::add_to_queue_next,
            play_cmds::add_tracks_to_queue,
            play_cmds::add_tracks_to_queue_next,
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
            play_cmds::get_gpu_acceleration,
            // Close to Tray Settings Command
            play_cmds::set_close_to_tray,
            background_app::get_background_app_status,
            background_app::request_background_app,
            background_app::set_background_app_enabled,
            background_app::hide_to_background,
            // Discord RPC Settings Command
            set_discord_rpc_enabled,
            is_kde_desktop,
            // App Control Command
            exit_app,
            write_log_to_disk
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
}

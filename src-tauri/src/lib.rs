pub mod artwork_cache;
pub mod audio;
pub mod autoeq;
pub mod background_app;
pub mod commands;
pub mod discord;
pub mod embedded_curves;
pub mod error;
pub mod gnome_search;
pub mod library;
pub mod models;
pub mod utils;
mod app_state;
mod window_modes;
mod window_state;

use audio::player::AudioPlayer;
use audio::queue::PlaybackQueue;
use commands::playback::QueueState;
use commands::{library as lib_cmds, playback as play_cmds, playlist as list_cmds};
use library::database::Database;
use models::PlaybackState;
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(target_os = "windows")]
use std::ffi::c_void;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager};

pub use app_state::{
    ArtworkCache, DiscordRpcEnabled, DiscordRpcQualityEnabled, FrontendVisible,
    NormalizationAnalysisLock, ScanLock,
};
use app_state::{
    OpenFilesWorker, RendererLifecycleState, claim_artwork_fetch, release_artwork_fetch,
};
pub(crate) use window_modes::{
    frontend_ready, hide_main_window, leave_mini_player, leave_theater_mode,
    set_renderer_suspension_enabled, show_main_window, show_mini_player, show_theater_mode,
    show_window_now,
};
#[cfg(target_os = "linux")]
pub(crate) use window_modes::{enable_gnome_touch_window_drag, guard_gnome_webview_touch_from_resize};
pub(crate) use window_state::{
    WindowState, WindowStateWriteThrottle, clamp_window_axis, cleanup_window_state_temp,
    load_window_state, persist_window_state, restore_window_state,
    window_state_from_dimensions,
};

pub(crate) fn set_frontend_visibility(app: &tauri::AppHandle, visible: bool) {
    if let Some(state) = app.try_state::<FrontendVisible>() {
        state.0.store(visible, Ordering::Relaxed);
    }
    if let Err(error) = app.emit("frontend-visibility-changed", visible) {
        eprintln!("[Viby] Failed to emit frontend visibility change: {error}");
    }
}

fn resolve_launch_paths(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

fn open_launch_files(app: &tauri::AppHandle, args: &[String], cwd: &Path) {
    let paths: Vec<_> = resolve_launch_paths(args, cwd)
        .into_iter()
        .filter(|path| path.is_file() && library::scanner::is_audio_file(path))
        .collect();
    if paths.is_empty() {
        return;
    }

    let Some(worker) = app.try_state::<OpenFilesWorker>() else {
        return;
    };
    if let Err(error) = worker.0.send((app.clone(), paths)) {
        eprintln!("[Viby] Failed to queue audio files: {error}");
    }
}

fn handle_cli_action_args(app: &tauri::AppHandle, args: &[String]) -> bool {
    if args.iter().any(|arg| arg == "--mini") {
        let _ = show_mini_player(app.clone());
        true
    } else if args.iter().any(|arg| arg == "--toggle-play") {
        let player = app.state::<AudioPlayer>();
        if player.is_playing() {
            player.pause();
        } else {
            player.resume();
        }
        true
    } else if args.iter().any(|arg| arg == "--next") {
        let _ = play_cmds::next_track(
            app.clone(),
            Some(true),
            app.state::<AudioPlayer>(),
            app.state::<QueueState>(),
            app.state::<Mutex<Database>>(),
        );
        true
    } else if args.iter().any(|arg| arg == "--previous") {
        let _ = play_cmds::previous_track(
            app.clone(),
            Some(true),
            app.state::<AudioPlayer>(),
            app.state::<QueueState>(),
            app.state::<Mutex<Database>>(),
        );
        true
    } else {
        false
    }
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

pub(crate) fn get_app_data_dir() -> std::path::PathBuf {
    let identifier = "com.viby.app";
    // This runs before Tauri's setup hook, where `app.path()` is not yet
    // available. The environment-variable fallback follows the same platform
    // conventions Tauri uses later: APPDATA on Windows, Application Support on
    // macOS, and XDG_DATA_HOME/`.local/share` on Linux and other Unix desktops.
    // Windows
    #[cfg(target_os = "windows")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_fitting_window_inside_work_area() {
        assert_eq!(clamp_window_axis(-200, 800, 0, 1200), 0);
        assert_eq!(clamp_window_axis(700, 800, 0, 1200), 400);
    }

    #[test]
    fn resolves_desktop_entry_file_arguments() {
        let args = vec![
            "viby".to_string(),
            "relative song.flac".to_string(),
            "/music/absolute.opus".to_string(),
        ];

        assert_eq!(
            resolve_launch_paths(&args, Path::new("/home/test")),
            vec![
                PathBuf::from("/home/test/relative song.flac"),
                PathBuf::from("/music/absolute.opus"),
            ]
        );
    }

    #[test]
    fn keeps_oversized_window_partially_visible() {
        assert_eq!(clamp_window_axis(-1_000, 1_000, 0, 800), -920);
        assert_eq!(clamp_window_axis(1_000, 1_000, 0, 800), 720);
    }

    #[test]
    fn accepts_legacy_size_only_state() {
        let state: WindowState = serde_json::from_str(r#"{"width": 1200, "height": 800}"#)
            .expect("legacy window state should remain readable");

        assert_eq!(state.x, None);
        assert_eq!(state.y, None);
        assert_eq!(state.width, 1200);
        assert_eq!(state.height, 800);
    }

    #[test]
    fn rejects_window_state_below_minimum_dimensions() {
        assert!(window_state_from_dimensions(959, 680, Some(0), Some(0)).is_none());
        assert!(window_state_from_dimensions(960, 679, Some(0), Some(0)).is_none());
        assert!(window_state_from_dimensions(960, 680, Some(0), Some(0)).is_some());
    }

    #[test]
    fn throttles_resize_writes_but_allows_close_flush() {
        let throttle = WindowStateWriteThrottle::default();

        assert!(throttle.allow(false));
        assert!(!throttle.allow(false));
        assert!(throttle.allow(true));
    }

    #[test]
    fn artwork_cache_enforces_byte_and_entry_limits() {
        let mut cache = ArtworkCache {
            entries: HashMap::new(),
            order: VecDeque::new(),
            max_entries: 2,
            max_bytes: 6,
            current_bytes: 0,
        };

        cache.insert("one".into(), Some((vec![1; 3], "image/jpeg".into())));
        cache.insert("two".into(), Some((vec![2; 3], "image/jpeg".into())));
        cache.insert("three".into(), Some((vec![3; 3], "image/jpeg".into())));

        assert!(cache.get("one").is_none());
        assert!(cache.get("two").is_some());
        assert!(cache.get("three").is_some());
        assert_eq!(cache.current_bytes, 6);

        cache.clear();
        assert_eq!(cache.current_bytes, 0);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn artwork_fetches_are_deduplicated_per_cache_key() {
        let mut in_flight = HashSet::new();

        assert!(claim_artwork_fetch(&mut in_flight, "artist||album"));
        assert!(!claim_artwork_fetch(&mut in_flight, "artist||album"));
        assert!(claim_artwork_fetch(&mut in_flight, "other||album"));

        release_artwork_fetch(&mut in_flight, "artist||album");
        assert!(in_flight.contains("other||album"));
        release_artwork_fetch(&mut in_flight, "other||album");
        assert!(in_flight.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn validates_native_theme_colors() {
        assert!(gtk_color("rgba(10, 20, 30, 0.5)").is_ok());
        assert!(gtk_color("red; } window { color: red").is_err());
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn schedule_discord_presence_flush(
    app: tauri::AppHandle,
    scheduled: Arc<AtomicBool>,
    delay: Duration,
) {
    if scheduled.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(delay);
        scheduled.store(false, Ordering::SeqCst);

        let (Some(rpc), Some(enabled), Some(quality)) = (
            app.try_state::<discord::DiscordRpcState>(),
            app.try_state::<DiscordRpcEnabled>(),
            app.try_state::<DiscordRpcQualityEnabled>(),
        ) else {
            return;
        };
        if let Some(delay) = discord::flush_pending_presence(&rpc, &enabled.0, &quality.0) {
            schedule_discord_presence_flush(app, scheduled, delay);
        }
    });
}

#[tauri::command]
fn set_discord_rpc_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    rpc_enabled: tauri::State<DiscordRpcEnabled>,
    rpc: tauri::State<discord::DiscordRpcState>,
    player: tauri::State<AudioPlayer>,
) {
    rpc_enabled.0.store(enabled, Ordering::SeqCst);
    if !enabled {
        discord::clear_presence(&rpc);
        return;
    }
    if let Err(error) = app.emit("playback-state", player.get_state()) {
        eprintln!("[Viby] Failed to refresh playback state after RPC change: {error}");
    }
}

#[tauri::command]
fn set_discord_rpc_quality_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    quality_enabled: tauri::State<DiscordRpcQualityEnabled>,
    player: tauri::State<AudioPlayer>,
) {
    quality_enabled.0.store(enabled, Ordering::SeqCst);
    if let Err(error) = app.emit("playback-state", player.get_state()) {
        eprintln!("[Viby] Failed to refresh playback state after RPC quality change: {error}");
    }
}

#[tauri::command]
fn set_frontend_visible(app: tauri::AppHandle, visible: bool) {
    set_frontend_visibility(&app, visible);
}

#[cfg(target_os = "linux")]
fn linux_desktop_contains(name: &str) -> bool {
    [
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    ]
    .iter()
    .filter_map(|key| std::env::var(key).ok())
    .any(|value| value.to_ascii_lowercase().contains(name))
}

#[tauri::command]
fn is_kde_desktop() -> bool {
    #[cfg(target_os = "linux")]
    return linux_desktop_contains("kde");

    #[cfg(not(target_os = "linux"))]
    false
}

pub(crate) fn gnome_desktop_detected() -> bool {
    #[cfg(target_os = "linux")]
    return linux_desktop_contains("gnome");

    #[cfg(not(target_os = "linux"))]
    false
}

#[tauri::command]
fn is_gnome_desktop() -> bool {
    gnome_desktop_detected()
}

// Theme values are consumed by the Linux GTK implementation; other platforms
// still deserialize the payload but intentionally leave it unused.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWindowTheme {
    background: String,
    foreground: String,
    hover: String,
    active: String,
    accent: String,
    border: String,
    dark: bool,
}

#[cfg(target_os = "linux")]
thread_local! {
    static NATIVE_WINDOW_CSS: std::cell::RefCell<Option<gtk::CssProvider>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "linux")]
fn gtk_color(value: &str) -> Result<String, String> {
    gtk::gdk::RGBA::parse(value)
        .map(|color| color.to_string())
        .map_err(|_| format!("Invalid GTK color: {value}"))
}

#[tauri::command]
fn set_native_window_theme(app: tauri::AppHandle, theme: NativeWindowTheme) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if !is_gnome_desktop() {
            return Ok(());
        }

        let background = gtk_color(&theme.background)?;
        let foreground = gtk_color(&theme.foreground)?;
        let hover = gtk_color(&theme.hover)?;
        let active = gtk_color(&theme.active)?;
        let accent = gtk_color(&theme.accent)?;
        let border = gtk_color(&theme.border)?;
        let css = format!(
            "headerbar {{ background-color: {background}; background-image: none; color: {foreground}; border-bottom: 1px solid {border}; box-shadow: none; }}\n\
             headerbar label {{ color: {foreground}; font-size: 13px; font-weight: 600; }}\n\
             headerbar:backdrop {{ opacity: 0.82; }}\n\
             headerbar button:not(.titlebutton) {{ color: {foreground}; background-color: transparent; background-image: none; border-color: transparent; box-shadow: none; }}\n\
             headerbar button:not(.titlebutton):hover {{ background-color: {hover}; }}\n\
             headerbar button:not(.titlebutton):active, headerbar button:not(.titlebutton):checked {{ background-color: {active}; }}\n\
             headerbar button:not(.titlebutton):focus {{ border-color: {accent}; }}"
        );
        let dark = theme.dark;

        app.run_on_main_thread(move || {
            use gtk::prelude::*;

            if let Some(settings) = gtk::Settings::default() {
                settings.set_gtk_application_prefer_dark_theme(dark);
            }
            NATIVE_WINDOW_CSS.with(|slot| {
                let mut slot = slot.borrow_mut();
                let provider = slot.get_or_insert_with(|| {
                    let provider = gtk::CssProvider::new();
                    if let Some(screen) = gtk::gdk::Screen::default() {
                        gtk::StyleContext::add_provider_for_screen(
                            &screen,
                            &provider,
                            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
                        );
                    }
                    provider
                });
                if let Err(error) = provider.load_from_data(css.as_bytes()) {
                    eprintln!("Failed to apply native window theme: {error}");
                }
            });
        })
        .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "linux"))]
    let _ = (app, theme);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::utils::setup_panic_hook();
    crate::utils::setup_crash_signal_handler();
    #[cfg(target_family = "unix")]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        // Bound glibc's per-thread arenas and stop its dynamic trim threshold
        // from retaining temporary artwork/WebKit allocation bursts.
        let tunables = std::env::var("GLIBC_TUNABLES").unwrap_or_default();
        if std::env::var_os("MALLOC_ARENA_MAX").is_none()
            && !tunables.contains("glibc.malloc.arena_max=")
        {
            libc::mallopt(libc::M_ARENA_MAX, 8);
            std::env::set_var("MALLOC_ARENA_MAX", "8");
        }
        if std::env::var_os("MALLOC_TRIM_THRESHOLD_").is_none()
            && !tunables.contains("glibc.malloc.trim_threshold=")
        {
            libc::mallopt(libc::M_TRIM_THRESHOLD, 131_072);
            std::env::set_var("MALLOC_TRIM_THRESHOLD_", "131072");
        }
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
            let size = lib_cmds::artwork_size_from_query(request.uri().query());

            match lib_cmds::fetch_sized_artwork(path, size, &db, &artwork_cache) {
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
                        .try_state::<background_app::BackgroundAppState>()
                        .is_some_and(|s| s.enabled.load(Ordering::SeqCst));

                    if window.label() == "mini" || window.label() == "theater" {
                        api.prevent_close();
                        let _ = window.hide();
                        if !close_to_tray {
                            window.app_handle().exit(0);
                        }
                    } else {
                        persist_window_state(window, true);

                        if close_to_tray {
                            api.prevent_close();
                            let app = window.app_handle().clone();
                            let app_for_thread = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                if let Some(window) = app_for_thread.get_webview_window("main") {
                                    let _ = hide_main_window(&app_for_thread, &window);
                                }
                            });
                        }
                    }
                }
                // Work around a Windows rendering glitch on resize.
                tauri::WindowEvent::Resized(_) => {
                    persist_window_state(window, false);

                    #[cfg(target_os = "windows")]
                    std::thread::sleep(std::time::Duration::from_nanos(1));
                }
                tauri::WindowEvent::Moved(_) => persist_window_state(window, false),
                _ => {}
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !handle_cli_action_args(&app_clone, &args) {
                    show_main_window(&app_clone);
                }
                open_launch_files(&app_clone, &args, Path::new(&cwd));
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            cleanup_window_state_temp();

            gnome_search::register_gnome_search_provider(app.handle());

            // Get platform-specific AppData directory
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            app.manage(WindowStateWriteThrottle::default());

            // Keep native GTK decorations on GNOME desktop.
            if let Some(_window) = app.get_webview_window("main") {
                #[cfg(target_os = "linux")]
                if is_gnome_desktop() {
                    enable_gnome_touch_window_drag(&_window);
                } else {
                    let _ = _window.set_decorations(false);
                }
                #[cfg(not(target_os = "linux"))]
                let _ = _window.set_decorations(false);

                if let Some(state) = load_window_state() {
                    restore_window_state(&_window, state);
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

                show_window_now(app.handle());
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
            let db = Database::open(&db_path)?;

            // Initialize Audio Engine
            let player = AudioPlayer::new(app.handle().clone());
            let queue = PlaybackQueue::new();

            // Inject states into Tauri Manager so commands can access them
            app.manage(Mutex::new(db));
            app.manage(player);
            app.manage(QueueState(Mutex::new(queue)));

            let (open_files_tx, open_files_rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for (app, paths) in open_files_rx {
                    if let Err(error) = play_cmds::open_audio_files(&app, paths) {
                        eprintln!("[Viby] Failed to open audio files: {error}");
                    }
                }
            });
            app.manage(OpenFilesWorker(open_files_tx));

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
                        desktop_entry: Some("com.viby.app"),
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
                desktop_entry: Some("com.viby.app"),
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
                                        show_main_window(&handle_clone)
                                    });
                                }
                                souvlaki::MediaControlEvent::Seek(direction) => {
                                    let current_pos = player.get_state().position_secs;
                                    let step = 10.0;
                                    let new_pos = match direction {
                                        souvlaki::SeekDirection::Forward => current_pos + step,
                                        souvlaki::SeekDirection::Backward => current_pos - step,
                                    };
                                    player.seek(new_pos.max(0.0));
                                }
                                souvlaki::MediaControlEvent::SeekBy(direction, duration) => {
                                    let current_pos = player.get_state().position_secs;
                                    let delta = duration.as_secs_f64();
                                    let new_pos = match direction {
                                        souvlaki::SeekDirection::Forward => current_pos + delta,
                                        souvlaki::SeekDirection::Backward => current_pos - delta,
                                    };
                                    player.seek(new_pos.max(0.0));
                                }
                                souvlaki::MediaControlEvent::SetPosition(
                                    souvlaki::MediaPosition(pos),
                                ) => {
                                    player.seek(pos.as_secs_f64());
                                }
                                souvlaki::MediaControlEvent::SetVolume(vol) => {
                                    player.set_volume(vol as f32);
                                }
                                souvlaki::MediaControlEvent::Quit => {
                                    handle.exit(0);
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
            app.manage(NormalizationAnalysisLock(AtomicBool::new(false)));
            app.manage(background_app::BackgroundAppState::new(true));
            app.manage(RendererLifecycleState::new());
            app.manage(Mutex::new(ArtworkCache {
                entries: HashMap::new(),
                order: VecDeque::new(),
                max_entries: 128,
                max_bytes: 64 * 1024 * 1024,
                current_bytes: 0,
            }));

            // Initialize Discord Rich Presence (optional — silently skipped if
            // Discord is not running or the client ID is not configured).
            // Disabled by default; the frontend syncs the persisted setting on startup.
            let discord_rpc = discord::DiscordRpcState(Mutex::new(discord::DiscordRpcInner::new()));
            app.manage(discord_rpc);
            app.manage(DiscordRpcEnabled(AtomicBool::new(false)));
            // Playback quality in the RPC status line is opt-in; the frontend
            // syncs the persisted setting on startup.
            app.manage(DiscordRpcQualityEnabled(AtomicBool::new(false)));
            app.manage(FrontendVisible(AtomicBool::new(true)));

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

            let mut tray = TrayIconBuilder::with_id("main").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _tray = tray
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick { .. } => {
                        show_main_window(tray.app_handle());
                    }
                    _ => {}
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "mini_player" => {
                        let _ = show_mini_player(app.clone());
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
                    "show" => show_main_window(app),
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
            let playback_gen = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let fetch_in_flight = Arc::new(Mutex::new(HashSet::<String>::new()));
            let presence_flush_scheduled = Arc::new(AtomicBool::new(false));
            app.listen("playback-state", move |event| {
                if let Ok(state) = serde_json::from_str::<PlaybackState>(event.payload()) {
                    let label = if state.is_playing { "Pause" } else { "Play" };
                    let _ = play_pause.set_text(label);

                    if std::env::var("VIBY_PLAYBACK_DEBUG").is_ok_and(|value| {
                        matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
                    }) {
                        let track_title = state
                            .current_track
                            .as_ref()
                            .map(|t| t.title.as_str())
                            .unwrap_or("None");
                        crate::utils::log_rust_event(
                            "playback_state_listener",
                            &format!(
                                "Event: playing={}, track={}, pos={:.2}s",
                                state.is_playing, track_title, state.position_secs
                            ),
                        );
                    }

                    if !discord_handle
                        .try_state::<DiscordRpcEnabled>()
                        .is_some_and(|state| state.0.load(Ordering::SeqCst))
                    {
                        return;
                    }

                    let event_id = playback_gen.fetch_add(1, Ordering::SeqCst) + 1;
                    let handle_clone = discord_handle.clone();
                    let state_clone = state.clone();
                    let fetch_gen_clone = Arc::clone(&fetch_gen);
                    let playback_gen_clone = Arc::clone(&playback_gen);
                    let fetch_in_flight_clone = Arc::clone(&fetch_in_flight);
                    let presence_flush_scheduled_clone = Arc::clone(&presence_flush_scheduled);

                    tauri::async_runtime::spawn_blocking(move || {
                        let Some(enabled) = handle_clone.try_state::<DiscordRpcEnabled>() else {
                            return;
                        };
                        let Some(quality) = handle_clone.try_state::<DiscordRpcQualityEnabled>()
                        else {
                            return;
                        };
                        let Some(rpc) = handle_clone.try_state::<discord::DiscordRpcState>() else {
                            crate::utils::log_rust_event(
                                "playback_state_listener",
                                "DiscordRpcState not found in app state",
                            );
                            return;
                        };
                        if playback_gen_clone.load(Ordering::SeqCst) != event_id {
                            return;
                        }

                        let Some(track) = &state_clone.current_track else {
                            fetch_gen_clone.fetch_add(1, Ordering::SeqCst);
                            if let Some(delay) = discord::update_presence(
                                &rpc,
                                &enabled.0,
                                &quality.0,
                                &state_clone,
                                None,
                            ) {
                                schedule_discord_presence_flush(
                                    handle_clone.clone(),
                                    Arc::clone(&presence_flush_scheduled_clone),
                                    delay,
                                );
                            }
                            return;
                        };

                        let artist = track.artist.clone();
                        let album = track.album.clone();
                        let key = artwork_cache::cache_key(&artist, &album);

                        let cache = handle_clone.state::<artwork_cache::DiscordArtworkCache>();
                        if playback_gen_clone.load(Ordering::SeqCst) != event_id {
                            return;
                        }

                        match cache.get(&key) {
                            Some(cached_info) => {
                                // A cached track supersedes any older in-flight fetch.
                                fetch_gen_clone.fetch_add(1, Ordering::SeqCst);
                                if let Some(delay) = discord::update_presence(
                                    &rpc,
                                    &enabled.0,
                                    &quality.0,
                                    &state_clone,
                                    cached_info.as_ref(),
                                ) {
                                    schedule_discord_presence_flush(
                                        handle_clone.clone(),
                                        Arc::clone(&presence_flush_scheduled_clone),
                                        delay,
                                    );
                                }
                            }
                            None => {
                                // Not cached — show viby_logo now, fetch in background.
                                if let Some(delay) = discord::update_presence(
                                    &rpc,
                                    &enabled.0,
                                    &quality.0,
                                    &state_clone,
                                    None,
                                ) {
                                    schedule_discord_presence_flush(
                                        handle_clone.clone(),
                                        Arc::clone(&presence_flush_scheduled_clone),
                                        delay,
                                    );
                                }

                                // Skip fetch if both fields are empty (no useful search term).
                                if artist.is_empty() && album.is_empty() {
                                    fetch_gen_clone.fetch_add(1, Ordering::SeqCst);
                                    return;
                                }

                                let should_start_fetch = {
                                    let mut in_flight = fetch_in_flight_clone
                                        .lock()
                                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                                    claim_artwork_fetch(&mut in_flight, &key)
                                };
                                if !should_start_fetch {
                                    return;
                                }

                                let fetch_id = fetch_gen_clone
                                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                                    + 1;
                                let fetch_gen_clone2 = Arc::clone(&fetch_gen_clone);
                                let handle_clone2 = handle_clone.clone();
                                let key_clone = key.clone();
                                let fetch_in_flight_clone2 = Arc::clone(&fetch_in_flight_clone);
                                let presence_flush_scheduled_clone2 =
                                    Arc::clone(&presence_flush_scheduled_clone);

                                tauri::async_runtime::spawn(async move {
                                    let result =
                                        artwork_cache::fetch_itunes_info(&artist, &album).await;

                                    let is_current_fetch = fetch_gen_clone2
                                        .load(std::sync::atomic::Ordering::SeqCst)
                                        == fetch_id;
                                    let cache =
                                        handle_clone2.state::<artwork_cache::DiscordArtworkCache>();
                                    match &result {
                                        // Persist confirmed hits (including confirmed no-artwork
                                        // results), but only back off briefly after failures.
                                        Ok(info) => {
                                            cache.insert_and_save(key_clone.clone(), info.clone())
                                        }
                                        Err(()) => cache.record_failure(key_clone.clone()),
                                    }

                                    let mut in_flight = fetch_in_flight_clone2
                                        .lock()
                                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                                    release_artwork_fetch(&mut in_flight, &key_clone);
                                    drop(in_flight);

                                    let Ok(info) = result else { return };

                                    // Discard if a newer fetch has already started (user skipped).
                                    if !is_current_fetch {
                                        return;
                                    }

                                    let current_state =
                                        handle_clone2.state::<AudioPlayer>().get_state();
                                    let current_key =
                                        current_state.current_track.as_ref().map(|track| {
                                            artwork_cache::cache_key(&track.artist, &track.album)
                                        });
                                    if current_key.as_deref() != Some(key_clone.as_str()) {
                                        return;
                                    }

                                    let handle_clone3 = handle_clone2.clone();
                                    let state_clone3 = current_state;
                                    let info_clone = info.clone();
                                    let presence_flush_scheduled_clone3 =
                                        Arc::clone(&presence_flush_scheduled_clone2);
                                    tauri::async_runtime::spawn_blocking(move || {
                                        if let (Some(rpc), Some(enabled), Some(quality)) = (
                                            handle_clone3.try_state::<discord::DiscordRpcState>(),
                                            handle_clone3.try_state::<DiscordRpcEnabled>(),
                                            handle_clone3.try_state::<DiscordRpcQualityEnabled>(),
                                        ) {
                                            if let Some(delay) = discord::update_presence(
                                                &rpc,
                                                &enabled.0,
                                                &quality.0,
                                                &state_clone3,
                                                info_clone.as_ref(),
                                            ) {
                                                schedule_discord_presence_flush(
                                                    handle_clone3.clone(),
                                                    presence_flush_scheduled_clone3,
                                                    delay,
                                                );
                                            }
                                        }
                                    });
                                });
                            }
                        }
                    });
                }
            });

            let args: Vec<_> = std::env::args_os()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            open_launch_files(
                app.handle(),
                &args,
                &std::env::current_dir().unwrap_or_default(),
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Library Commands
            lib_cmds::pick_library_folders,
            lib_cmds::remove_library_folder,
            lib_cmds::get_library_folders,
            lib_cmds::scan_library,
            lib_cmds::analyze_missing_normalization,
            lib_cmds::get_all_tracks,
            lib_cmds::get_album_tracks,
            lib_cmds::get_albums,
            lib_cmds::get_artists,
            lib_cmds::get_genres,
            lib_cmds::search,
            lib_cmds::get_track_artwork,
            lib_cmds::clear_artwork_cache,
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
            play_cmds::set_sound_check_enabled,
            play_cmds::set_sound_check_target_lufs,
            play_cmds::set_eq,
            play_cmds::get_track_eq_override,
            play_cmds::save_track_eq_override,
            play_cmds::preview_track_eq_override,
            play_cmds::clear_track_eq_override,
            play_cmds::delete_track_eq_override,
            play_cmds::set_peq,
            play_cmds::calculate_eq_response,
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
            play_cmds::add_headphone_measurement,
            play_cmds::delete_headphone_measurement,
            play_cmds::pick_eq_filter_file,
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
            background_app::get_background_app_status,
            background_app::request_background_app,
            background_app::set_background_app_enabled,
            background_app::hide_to_background,
            // Discord RPC Settings Command
            set_discord_rpc_enabled,
            set_discord_rpc_quality_enabled,
            set_frontend_visible,
            set_renderer_suspension_enabled,
            frontend_ready,
            show_mini_player,
            leave_mini_player,
            show_theater_mode,
            leave_theater_mode,
            is_kde_desktop,
            is_gnome_desktop,
            set_native_window_theme,
            // App Control Command
            exit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                if let Some(player) = app.try_state::<AudioPlayer>() {
                    player.shutdown();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}

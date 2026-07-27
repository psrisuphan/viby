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

use audio::player::AudioPlayer;
use audio::queue::PlaybackQueue;
use commands::playback::QueueState;
use commands::{library as lib_cmds, playback as play_cmds, playlist as list_cmds};
use library::database::Database;
use models::PlaybackState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
#[cfg(target_os = "windows")]
use std::ffi::c_void;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager};

const WINDOW_STATE_MIN_WIDTH: u32 = 960;
const WINDOW_STATE_MIN_HEIGHT: u32 = 680;
const WINDOW_STATE_WRITE_INTERVAL: Duration = Duration::from_millis(250);
const WINDOW_STATE_MIN_VISIBLE_PIXELS: i64 = 80;

/// In-process artwork cache keyed by album key ("album||album_artist").
/// Stores the raw image bytes + MIME type so `get_track_artwork` never
/// re-reads the same audio file or folder image twice per session.
struct OpenFilesWorker(std::sync::mpsc::Sender<(tauri::AppHandle, Vec<PathBuf>)>);

pub struct ArtworkCache {
    pub entries: HashMap<String, Option<(Vec<u8>, String)>>,
    pub order: VecDeque<String>,
    pub max_entries: usize,
    pub max_bytes: usize,
    pub current_bytes: usize,
}

impl ArtworkCache {
    pub fn get(&self, key: &str) -> Option<Option<(Vec<u8>, String)>> {
        self.entries.get(key).cloned()
    }

    pub fn insert(&mut self, key: String, value: Option<(Vec<u8>, String)>) {
        let value_bytes = value.as_ref().map_or(0, |(bytes, _)| bytes.len());
        if value_bytes > self.max_bytes {
            return;
        }

        if let Some(previous) = self.entries.remove(&key) {
            self.current_bytes = self
                .current_bytes
                .saturating_sub(previous.as_ref().map_or(0, |(bytes, _)| bytes.len()));
            self.order.retain(|existing| existing != &key);
        }

        while self.entries.len() >= self.max_entries
            || self.current_bytes.saturating_add(value_bytes) > self.max_bytes
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(previous) = self.entries.remove(&oldest) {
                self.current_bytes = self
                    .current_bytes
                    .saturating_sub(previous.as_ref().map_or(0, |(bytes, _)| bytes.len()));
            }
        }

        self.current_bytes += value_bytes;
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.current_bytes = 0;
    }
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

pub struct NormalizationAnalysisLock(pub AtomicBool);

impl NormalizationAnalysisLock {
    pub fn try_acquire(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct DiscordRpcEnabled(pub AtomicBool);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct WindowState {
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    width: u32,
    height: u32,
}

struct WindowStateWriteThrottle(Mutex<Instant>);

impl Default for WindowStateWriteThrottle {
    fn default() -> Self {
        Self(Mutex::new(
            Instant::now()
                .checked_sub(WINDOW_STATE_WRITE_INTERVAL)
                .unwrap_or_else(Instant::now),
        ))
    }
}

impl WindowStateWriteThrottle {
    fn allow(&self, force: bool) -> bool {
        let Ok(mut last_write) = self.0.lock() else {
            return force;
        };

        if !force && last_write.elapsed() < WINDOW_STATE_WRITE_INTERVAL {
            return false;
        }

        *last_write = Instant::now();
        true
    }
}

pub struct FrontendVisible(pub AtomicBool);

pub struct RendererLifecycleState {
    enabled: AtomicBool,
    terminated: AtomicBool,
    restoring: AtomicBool,
    generation: AtomicU64,
}

impl RendererLifecycleState {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(cfg!(target_os = "linux")),
            terminated: AtomicBool::new(false),
            restoring: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }
}

pub(crate) fn set_frontend_visibility(app: &tauri::AppHandle, visible: bool) {
    if let Some(state) = app.try_state::<FrontendVisible>() {
        state.0.store(visible, Ordering::Relaxed);
    }
    let _ = app.emit("frontend-visibility-changed", visible);
}

fn show_window_now(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.show().is_ok() {
            set_frontend_visibility(app, true);
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn hide_main_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())?;
    set_frontend_visibility(app, false);
    if let Some(cache) = app.try_state::<Mutex<ArtworkCache>>()
        && let Ok(mut cache) = cache.lock()
    {
        cache.entries.clear();
        cache.order.clear();
    }

    #[cfg(target_os = "linux")]
    if let Some(state) = app.try_state::<RendererLifecycleState>()
        && state.enabled.load(Ordering::Relaxed)
        && state
            .terminated
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        state.restoring.store(false, Ordering::Relaxed);
        let app_handle = app.clone();
        if let Err(err) = window.with_webview(move |webview| {
            use webkit2gtk::WebViewExt;
            webview.inner().terminate_web_process();
            eprintln!("[Viby] Background WebKit renderer terminated.");
        }) {
            if let Some(state) = app_handle.try_state::<RendererLifecycleState>() {
                state.terminated.store(false, Ordering::Relaxed);
                state.enabled.store(false, Ordering::Relaxed);
            }
            eprintln!("[Viby] Renderer termination unavailable; using window hide: {err}");
        }
    }

    Ok(())
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

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        if let Some(handle) = slot.borrow_mut().take() {
            background_app::uninhibit_idle_session(handle);
        }
    });
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    if let Some(theater) = app.get_webview_window("theater") {
        let _ = theater.hide();
    }
    let Some(state) = app.try_state::<RendererLifecycleState>() else {
        show_window_now(app);
        return;
    };
    if !state.terminated.load(Ordering::Relaxed) {
        show_window_now(app);
        return;
    }
    if state.restoring.swap(true, Ordering::SeqCst) {
        return;
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = app.get_webview_window("main") else {
        state.restoring.store(false, Ordering::Relaxed);
        return;
    };
    if let Err(err) = window.reload() {
        eprintln!("[Viby] Failed to restore background renderer: {err}");
        state.enabled.store(false, Ordering::Relaxed);
        state.terminated.store(false, Ordering::Relaxed);
        state.restoring.store(false, Ordering::Relaxed);
        show_window_now(app);
        return;
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Some(state) = app_handle.try_state::<RendererLifecycleState>() else {
            return;
        };
        if state.generation.load(Ordering::SeqCst) != generation
            || !state.restoring.load(Ordering::Relaxed)
        {
            return;
        }
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.reload();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        if state.generation.load(Ordering::SeqCst) == generation
            && state.restoring.swap(false, Ordering::SeqCst)
        {
            eprintln!("[Viby] Renderer restore timed out; disabling suspension for this session.");
            state.enabled.store(false, Ordering::Relaxed);
            state.terminated.store(false, Ordering::Relaxed);
            show_window_now(&app_handle);
        }
    });
}

#[tauri::command]
fn set_renderer_suspension_enabled(enabled: bool, state: tauri::State<RendererLifecycleState>) {
    state
        .enabled
        .store(cfg!(target_os = "linux") && enabled, Ordering::Relaxed);
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<RendererLifecycleState>() else {
        return;
    };
    if !state.restoring.swap(false, Ordering::SeqCst) {
        return;
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.terminated.store(false, Ordering::Relaxed);
    show_window_now(&app);
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

fn window_state_path() -> std::path::PathBuf {
    get_app_data_dir().join("window_state.json")
}

fn window_state_temp_path() -> std::path::PathBuf {
    get_app_data_dir().join("window_state.json.tmp")
}

#[cfg(target_os = "windows")]
fn window_state_backup_path() -> std::path::PathBuf {
    get_app_data_dir().join("window_state.json.bak")
}

fn cleanup_window_state_temp() {
    #[cfg(target_os = "windows")]
    {
        let path = window_state_path();
        let backup_path = window_state_backup_path();

        if !path.exists() {
            let _ = std::fs::rename(&backup_path, &path);
        }
        let _ = std::fs::remove_file(backup_path);
    }

    let _ = std::fs::remove_file(window_state_temp_path());
}

fn load_window_state() -> Option<WindowState> {
    let path = window_state_path();
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_window_state(state: WindowState) -> Result<(), String> {
    use std::fs::{create_dir_all, write};

    let path = window_state_path();
    let temp_path = window_state_temp_path();
    if let Some(parent) = temp_path.parent() {
        create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(&state).map_err(|err| err.to_string())?;
    if let Err(err) = write(&temp_path, payload) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let backup_path = window_state_backup_path();
        let had_existing_state = path.exists();

        let _ = std::fs::remove_file(&backup_path);
        if had_existing_state && let Err(err) = std::fs::rename(&path, &backup_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(err.to_string());
        }

        if let Err(err) = std::fs::rename(&temp_path, &path) {
            let _ = std::fs::remove_file(&temp_path);
            if had_existing_state {
                let _ = std::fs::rename(&backup_path, &path);
            }
            return Err(err.to_string());
        }

        let _ = std::fs::remove_file(backup_path);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    match std::fs::rename(&temp_path, &path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(err.to_string())
        }
    }
}

fn clamp_window_axis(position: i32, size: u32, area_start: i32, area_size: u32) -> i32 {
    let position = i64::from(position);
    let size = i64::from(size);
    let area_start = i64::from(area_start);
    let area_size = i64::from(area_size);
    let area_end = area_start + area_size;
    let (min_position, max_position) = if size <= area_size {
        (area_start, area_end - size)
    } else {
        (
            area_start + WINDOW_STATE_MIN_VISIBLE_PIXELS - size,
            area_end - WINDOW_STATE_MIN_VISIBLE_PIXELS,
        )
    };

    position.clamp(min_position, max_position) as i32
}

fn persist_window_state<R: tauri::Runtime>(window: &tauri::Window<R>, force: bool) {
    if window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
    {
        return;
    }

    let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else {
        return;
    };

    if size.width >= WINDOW_STATE_MIN_WIDTH
        && size.height >= WINDOW_STATE_MIN_HEIGHT
        && window
            .app_handle()
            .try_state::<WindowStateWriteThrottle>()
            .map(|throttle| throttle.allow(force))
            .unwrap_or(force)
    {
        let _ = save_window_state(WindowState {
            x: Some(position.x),
            y: Some(position.y),
            width: size.width,
            height: size.height,
        });
    }
}

fn restore_window_state<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, state: WindowState) {
    if state.width < WINDOW_STATE_MIN_WIDTH || state.height < WINDOW_STATE_MIN_HEIGHT {
        return;
    }

    let Some((x, y)) = state.x.zip(state.y) else {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: state.width,
            height: state.height,
        }));
        return;
    };

    let restored_position = window
        .available_monitors()
        .ok()
        .map(|monitors| {
            let right = i64::from(x) + i64::from(state.width);
            let bottom = i64::from(y) + i64::from(state.height);

            monitors.iter().find_map(|monitor| {
                let area = monitor.work_area();
                let area_right = i64::from(area.position.x) + i64::from(area.size.width);
                let area_bottom = i64::from(area.position.y) + i64::from(area.size.height);

                (i64::from(x) < area_right
                    && right > i64::from(area.position.x)
                    && i64::from(y) < area_bottom
                    && bottom > i64::from(area.position.y))
                .then(|| tauri::PhysicalPosition {
                    x: clamp_window_axis(x, state.width, area.position.x, area.size.width),
                    y: clamp_window_axis(y, state.height, area.position.y, area.size.height),
                })
            })
        })
        .flatten();

    if let Some(position) = restored_position {
        let _ = window.set_position(tauri::Position::Physical(position));
    }

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: state.width,
        height: state.height,
    }));
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

#[tauri::command]
fn is_gnome_desktop() -> bool {
    #[cfg(target_os = "linux")]
    return linux_desktop_contains("gnome");

    #[cfg(not(target_os = "linux"))]
    false
}

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
    static THEATER_INHIBIT_HANDLE: std::cell::RefCell<Option<zbus::zvariant::OwnedObjectPath>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "linux")]
fn gtk_color(value: &str) -> Result<String, String> {
    gtk::gdk::RGBA::parse(value)
        .map(|color| color.to_string())
        .map_err(|_| format!("Invalid GTK color: {value}"))
}

#[cfg(target_os = "linux")]
fn gtk_point_hits_button(widget: &gtk::Widget, titlebar: &gtk::Widget, x: i32, y: i32) -> bool {
    use gtk::prelude::*;

    if widget.is::<gtk::Button>() && widget.is_visible() {
        let allocation = widget.allocation();
        if let Some((button_x, button_y)) = widget.translate_coordinates(titlebar, 0, 0)
            && x >= button_x
            && y >= button_y
            && x < button_x + allocation.width()
            && y < button_y + allocation.height()
        {
            return true;
        }
    }

    let Ok(container) = widget.clone().downcast::<gtk::Container>() else {
        return false;
    };
    let mut hit = false;
    container.forall(|child| {
        if !hit && gtk_point_hits_button(child, titlebar, x, y) {
            hit = true;
        }
    });
    hit
}

#[cfg(target_os = "linux")]
fn guard_gnome_webview_touch_from_resize<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|platform_webview| {
        use gtk::glib::translate::IntoGlib;
        use gtk::prelude::*;
        use std::cell::Cell;

        let webview = platform_webview.inner();
        let widget: &gtk::Widget = webview.upcast_ref();
        let instance = widget.as_ptr() as *mut gtk::glib::gobject_ffi::GObject;
        unsafe {
            let signal_id = gtk::glib::gobject_ffi::g_signal_lookup(
                b"touch-event\0".as_ptr().cast(),
                webview.type_().into_glib(),
            );
            let handler_id = gtk::glib::gobject_ffi::g_signal_handler_find(
                instance,
                gtk::glib::gobject_ffi::G_SIGNAL_MATCH_ID,
                signal_id,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if handler_id != 0 {
                gtk::glib::gobject_ffi::g_signal_handler_disconnect(instance, handler_id);
            }
        }

        let active_touches = Cell::new(0_u32);
        let restore_resizable = Cell::new(false);
        webview.connect_touch_event(move |webview, event| {
            let window = webview
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok())
                .filter(|w| w.is_realized() && w.is_visible());
            match event.event_type() {
                gtk::gdk::EventType::TouchBegin => {
                    if active_touches.get() == 0 {
                        if let Some(window) = window {
                            restore_resizable.set(window.is_resizable());
                            window.set_resizable(false);
                        }
                    }
                    active_touches.set(active_touches.get() + 1);
                }
                gtk::gdk::EventType::TouchEnd | gtk::gdk::EventType::TouchCancel => {
                    active_touches.set(active_touches.get().saturating_sub(1));
                    if active_touches.get() == 0 && restore_resizable.replace(false) {
                        if let Some(window) = window {
                            window.set_resizable(true);
                        }
                    }
                }
                _ => {}
            }
            gtk::glib::Propagation::Proceed
        });
    });
}

#[cfg(target_os = "linux")]
fn enable_gnome_touch_window_drag<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use gtk::{gdk::prelude::*, prelude::*};

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(titlebar) = gtk_window.titlebar() else {
        return;
    };
    titlebar.add_events(gtk::gdk::EventMask::TOUCH_MASK);
    let gtk_window = gtk_window.downgrade();

    titlebar.connect_touch_event(move |titlebar, event| {
        if event.event_type() != gtk::gdk::EventType::TouchBegin {
            return gtk::glib::Propagation::Proceed;
        }
        let Some((x, y)) = event.coords() else {
            return gtk::glib::Propagation::Proceed;
        };
        if gtk_point_hits_button(titlebar, titlebar, x as i32, y as i32) {
            return gtk::glib::Propagation::Proceed;
        }
        let (Some(gtk_window), Some(device), Some((root_x, root_y))) =
            (gtk_window.upgrade(), event.device(), event.root_coords())
        else {
            return gtk::glib::Propagation::Proceed;
        };
        if let Some(gdk_window) = gtk_window.window() {
            gdk_window.begin_move_drag_for_device(
                &device,
                0,
                root_x as i32,
                root_y as i32,
                event.time(),
            );
            return gtk::glib::Propagation::Stop;
        }

        gtk::glib::Propagation::Proceed
    });
}

#[tauri::command]
fn show_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    let mini = if let Some(win) = app.get_webview_window("mini") {
        win
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "mini",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Viby")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .inner_size(420.0, 200.0)
        .skip_taskbar(true)
        .visible(false);

        let win = builder.build().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        if is_gnome_desktop() {
            guard_gnome_webview_touch_from_resize(&win);
        }

        #[cfg(target_os = "macos")]
        let _ = window_vibrancy::apply_vibrancy(
            &win,
            window_vibrancy::NSVisualEffectMaterial::Sidebar,
            None,
            Some(14.0),
        );

        #[cfg(target_os = "windows")]
        let _ = window_vibrancy::apply_mica(&win, None);

        win
    };

    let _ = mini.show();
    let _ = mini.unminimize();
    let _ = mini.set_focus();

    if let Some(main) = app.get_webview_window("main") {
        let _ = hide_main_window(&app, &main);
    }

    Ok(())
}

#[tauri::command]
fn leave_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn show_theater_mode(app: tauri::AppHandle) -> Result<(), String> {
    let theater = if let Some(win) = app.get_webview_window("theater") {
        win
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "theater",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Viby Theater")
        .decorations(false)
        .transparent(true)
        .maximized(true)
        .visible(false);

        let win = builder.build().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        if is_gnome_desktop() {
            guard_gnome_webview_touch_from_resize(&win);
        }

        #[cfg(target_os = "macos")]
        let _ = window_vibrancy::apply_vibrancy(
            &win,
            window_vibrancy::NSVisualEffectMaterial::Sidebar,
            None,
            Some(14.0),
        );

        #[cfg(target_os = "windows")]
        let _ = window_vibrancy::apply_mica(&win, None);

        win
    };

    let _ = theater.show();
    let _ = theater.unminimize();
    let _ = theater.set_focus();

    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = background_app::inhibit_idle_session("Viby Theater Mode active");
        }
    });

    if let Some(main) = app.get_webview_window("main") {
        let _ = hide_main_window(&app, &main);
    }

    Ok(())
}

#[tauri::command]
fn leave_theater_mode(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        if let Some(handle) = slot.borrow_mut().take() {
            background_app::uninhibit_idle_session(handle);
        }
    });
    if let Some(theater) = app.get_webview_window("theater") {
        let _ = theater.hide();
    }
    show_main_window(&app);
    Ok(())
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

                let _ = _window.show();
            }

            app.manage(WindowStateWriteThrottle::default());

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
            let discord_rpc = discord::DiscordRpcState(Mutex::new(discord::DiscordRpcInner {
                client: None,
                last_connect_attempt: None,
                last_track_id: None,
                last_is_playing: false,
                last_position_baseline: None,
            }));
            app.manage(discord_rpc);
            app.manage(DiscordRpcEnabled(AtomicBool::new(false)));
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

                    let handle_clone = discord_handle.clone();
                    let state_clone = state.clone();
                    let fetch_gen_clone = Arc::clone(&fetch_gen);

                    tauri::async_runtime::spawn_blocking(move || {
                        let Some(enabled) = handle_clone.try_state::<DiscordRpcEnabled>() else {
                            return;
                        };
                        let Some(rpc) = handle_clone.try_state::<discord::DiscordRpcState>() else {
                            crate::utils::log_rust_event(
                                "playback_state_listener",
                                "DiscordRpcState not found in app state",
                            );
                            return;
                        };

                        let Some(track) = &state_clone.current_track else {
                            discord::update_presence(&rpc, &enabled.0, &state_clone, None);
                            return;
                        };

                        let artist = track.artist.clone();
                        let album = track.album.clone();
                        let key = artwork_cache::cache_key(&artist, &album);

                        let cache = handle_clone.state::<artwork_cache::DiscordArtworkCache>();

                        match cache.get(&key) {
                            Some(cached_url) => {
                                // Cache hit (positive or negative TTL-valid) — use immediately.
                                discord::update_presence(
                                    &rpc,
                                    &enabled.0,
                                    &state_clone,
                                    cached_url.as_deref(),
                                );
                            }
                            None => {
                                // Not cached — show viby_logo now, fetch in background.
                                discord::update_presence(&rpc, &enabled.0, &state_clone, None);

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
                                        if let (Some(rpc), Some(enabled)) = (
                                            handle_clone3.try_state::<discord::DiscordRpcState>(),
                                            handle_clone3.try_state::<DiscordRpcEnabled>(),
                                        ) {
                                            discord::update_presence(
                                                &rpc,
                                                &enabled.0,
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
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}

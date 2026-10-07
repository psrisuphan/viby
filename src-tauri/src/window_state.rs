use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const MIN_WIDTH: u32 = 960;
const MIN_HEIGHT: u32 = 680;
const WRITE_INTERVAL: Duration = Duration::from_millis(250);
#[cfg_attr(target_os = "linux", allow(dead_code))]
const MIN_VISIBLE_PIXELS: i64 = 80;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(crate) struct WindowState {
    #[serde(default)]
    pub(crate) x: Option<i32>,
    #[serde(default)]
    pub(crate) y: Option<i32>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct WindowStateWriteThrottle(Mutex<Instant>);

impl Default for WindowStateWriteThrottle {
    fn default() -> Self {
        Self(Mutex::new(
            Instant::now()
                .checked_sub(WRITE_INTERVAL)
                .unwrap_or_else(Instant::now),
        ))
    }
}

impl WindowStateWriteThrottle {
    pub(crate) fn allow(&self, force: bool) -> bool {
        let Ok(mut last_write) = self.0.lock() else {
            return force;
        };

        if !force && last_write.elapsed() < WRITE_INTERVAL {
            return false;
        }

        *last_write = Instant::now();
        true
    }

    pub(crate) fn reset(&self) {
        if let Ok(mut last_write) = self.0.lock() {
            *last_write = Instant::now()
                .checked_sub(WRITE_INTERVAL)
                .unwrap_or_else(Instant::now);
        }
    }
}

pub(crate) fn window_state_from_dimensions(
    width: u32,
    height: u32,
    x: Option<i32>,
    y: Option<i32>,
) -> Option<WindowState> {
    (width >= MIN_WIDTH && height >= MIN_HEIGHT).then_some(WindowState {
        x,
        y,
        width,
        height,
    })
}

fn capture_webview_window_state<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<WindowState> {
    if window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
    {
        return None;
    }

    let Ok(size) = window.inner_size() else {
        return None;
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_size = size.to_logical::<u32>(scale_factor);

    #[cfg(not(target_os = "linux"))]
    let (x, y) = window.outer_position().ok().map(|p| (p.x, p.y)).unzip();
    #[cfg(target_os = "linux")]
    let (x, y) = (None, None);

    window_state_from_dimensions(logical_size.width, logical_size.height, x, y)
}

pub(crate) fn sync_window_state<R: tauri::Runtime>(
    source: &tauri::WebviewWindow<R>,
    target: &tauri::WebviewWindow<R>,
) {
    let Some(state) = capture_webview_window_state(source) else {
        return;
    };

    if let Err(error) = save_window_state(state) {
        eprintln!("[Viby] Failed to persist window state while syncing modes: {error}");
    }
    if target.is_maximized().unwrap_or(false) {
        let _ = target.unmaximize();
    }
    restore_window_state(target, state);
}

fn window_state_path() -> std::path::PathBuf {
    crate::utils::get_app_data_dir().join("window_state.json")
}

fn window_state_temp_path() -> std::path::PathBuf {
    crate::utils::get_app_data_dir().join("window_state.json.tmp")
}

#[cfg(target_os = "windows")]
fn window_state_backup_path() -> std::path::PathBuf {
    crate::utils::get_app_data_dir().join("window_state.json.bak")
}

pub(crate) fn cleanup_window_state_temp() {
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

pub(crate) fn load_window_state() -> Option<WindowState> {
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

#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn clamp_window_axis(position: i32, size: u32, area_start: i32, area_size: u32) -> i32 {
    let position = i64::from(position);
    let size = i64::from(size);
    let area_start = i64::from(area_start);
    let area_size = i64::from(area_size);
    let area_end = area_start + area_size;
    let (min_position, max_position) = if size <= area_size {
        (area_start, area_end - size)
    } else {
        (
            area_start + MIN_VISIBLE_PIXELS - size,
            area_end - MIN_VISIBLE_PIXELS,
        )
    };

    position.clamp(min_position, max_position) as i32
}

pub(crate) fn persist_window_state<R: tauri::Runtime>(window: &tauri::Window<R>, force: bool) {
    if window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
    {
        return;
    }

    let Ok(size) = window.inner_size() else {
        return;
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_size = size.to_logical::<u32>(scale_factor);

    #[cfg(not(target_os = "linux"))]
    let (x, y) = window.outer_position().ok().map(|p| (p.x, p.y)).unzip();
    #[cfg(target_os = "linux")]
    let (x, y) = (None, None);

    if let Some(state) = window_state_from_dimensions(logical_size.width, logical_size.height, x, y)
        && window
            .app_handle()
            .try_state::<WindowStateWriteThrottle>()
            .map(|throttle| throttle.allow(force))
            .unwrap_or(force)
    {
        if let Err(error) = save_window_state(state) {
            eprintln!("[Viby] Failed to persist window state: {error}");
        }
    }
}

pub(crate) fn restore_window_state<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    state: WindowState,
) {
    if state.width < MIN_WIDTH || state.height < MIN_HEIGHT {
        return;
    }

    if let Some(throttle) = window.app_handle().try_state::<WindowStateWriteThrottle>() {
        throttle.reset();
    }

    #[cfg(not(target_os = "linux"))]
    if let Some((x, y)) = state.x.zip(state.y) {
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
    }

    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: f64::from(state.width),
        height: f64::from(state.height),
    }));
}

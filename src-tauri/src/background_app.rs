use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[cfg(target_os = "linux")]
const BACKGROUND_MESSAGE: &str = "Playing music";

#[cfg(target_os = "linux")]
pub fn inhibit_idle_session(reason: &str) -> Option<zbus::zvariant::OwnedObjectPath> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::Value;

    let conn = Connection::session().ok()?;
    let proxy = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Inhibit",
    )
    .ok()?;

    let mut options = HashMap::new();
    options.insert("reason", Value::from(reason));

    // Flags: 8 = Idle/Screensaver inhibition
    proxy.call("Inhibit", &("", 8_u32, options)).ok()
}

#[cfg(target_os = "linux")]
pub fn uninhibit_idle_session(handle: zbus::zvariant::OwnedObjectPath) {
    use zbus::blocking::{Connection, Proxy};

    if let Ok(conn) = Connection::session() {
        if let Ok(proxy) = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            &handle,
            "org.freedesktop.portal.Request",
        ) {
            let _: Result<(), _> = proxy.call("Close", &());
        }
    }
}

pub struct BackgroundAppState {
    pub enabled: AtomicBool,
    pub last_status: Mutex<Option<BackgroundAppStatus>>,
}

impl BackgroundAppState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            last_status: Mutex::new(None),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundAppStatus {
    pub enabled: bool,
    pub supported: bool,
    pub provider: &'static str,
    pub permission: &'static str,
    pub message: Option<String>,
}

impl BackgroundAppStatus {
    fn fallback(enabled: bool, message: impl Into<Option<String>>) -> Self {
        Self {
            enabled,
            supported: true,
            provider: fallback_provider(),
            permission: "not-required",
            message: message.into(),
        }
    }

    #[cfg(target_os = "linux")]
    fn portal_requested(enabled: bool) -> Self {
        Self {
            enabled,
            supported: true,
            provider: "linux-xdg-portal",
            permission: "unknown",
            message: Some("Background portal accepted the request.".to_string()),
        }
    }

    #[cfg(target_os = "linux")]
    fn portal_available(enabled: bool) -> Self {
        Self {
            enabled,
            supported: true,
            provider: "linux-xdg-portal",
            permission: "unknown",
            message: Some("Background portal will be requested when Viby hides.".to_string()),
        }
    }

    #[cfg(target_os = "linux")]
    fn portal_denied(enabled: bool, err: impl std::fmt::Display) -> Self {
        Self {
            enabled,
            supported: true,
            provider: fallback_provider(),
            permission: "unknown",
            message: Some(format!(
                "Background portal unavailable; using fallback: {err}"
            )),
        }
    }

    #[cfg(target_os = "linux")]
    fn portal_requires_sandbox(enabled: bool) -> Self {
        Self {
            enabled,
            supported: true,
            provider: fallback_provider(),
            permission: "not-required",
            message: Some(
                "GNOME Background Apps requires a sandboxed portal app; using window hide fallback."
                    .to_string(),
            ),
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn fallback_provider() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows-notification-area"
    }

    #[cfg(target_os = "macos")]
    {
        "macos-menu-bar"
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn fallback_provider() -> &'static str {
    "linux-window-hide"
}

fn fallback_message(enabled: bool) -> Option<String> {
    if !enabled {
        return None;
    }

    Some(match fallback_provider() {
        "windows-notification-area" => {
            "Viby will keep running in the notification area.".to_string()
        }
        "macos-menu-bar" => "Viby will keep running from the menu bar.".to_string(),
        "linux-window-hide" => "Viby will keep running without a visible window.".to_string(),
        _ => "Viby will keep running in the background.".to_string(),
    })
}

fn default_status(enabled: bool) -> BackgroundAppStatus {
    #[cfg(target_os = "linux")]
    {
        if is_sandboxed_linux_app() {
            return BackgroundAppStatus::portal_available(enabled);
        }
    }

    BackgroundAppStatus::fallback(enabled, fallback_message(enabled))
}

#[tauri::command]
pub fn get_background_app_status(
    state: tauri::State<'_, BackgroundAppState>,
) -> BackgroundAppStatus {
    let enabled = state.enabled.load(Ordering::SeqCst);
    if let Some(status) = state.last_status.lock().ok().and_then(|s| s.clone()) {
        return BackgroundAppStatus { enabled, ..status };
    }
    default_status(enabled)
}

#[tauri::command]
pub fn request_background_app(state: tauri::State<'_, BackgroundAppState>) -> BackgroundAppStatus {
    let enabled = state.enabled.load(Ordering::SeqCst);
    let status = request_background_status(enabled);
    if let Ok(mut last_status) = state.last_status.lock() {
        *last_status = Some(status.clone());
    }
    status
}

#[tauri::command]
pub fn set_background_app_enabled(
    enabled: bool,
    state: tauri::State<'_, BackgroundAppState>,
) -> BackgroundAppStatus {
    state.enabled.store(enabled, Ordering::SeqCst);
    if !enabled {
        clear_background_status();
    }

    let status = default_status(enabled);

    if let Ok(mut last_status) = state.last_status.lock() {
        *last_status = Some(status.clone());
    }
    status
}

#[tauri::command]
pub fn hide_to_background(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackgroundAppState>,
) -> Result<BackgroundAppStatus, String> {
    let enabled = state.enabled.load(Ordering::SeqCst);
    let status = if enabled {
        request_background_status(true)
    } else {
        BackgroundAppStatus::fallback(false, None)
    };

    if let Ok(mut last_status) = state.last_status.lock() {
        *last_status = Some(status.clone());
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    if let Some(theater) = app.get_webview_window("theater") {
        let _ = theater.hide();
    }
    crate::hide_main_window(&app, &window)?;

    Ok(status)
}

fn request_background_status(enabled: bool) -> BackgroundAppStatus {
    #[cfg(target_os = "linux")]
    {
        if !is_sandboxed_linux_app() {
            return BackgroundAppStatus::portal_requires_sandbox(enabled);
        }

        match request_linux_background() {
            Ok(()) => BackgroundAppStatus::portal_requested(enabled),
            Err(err) => BackgroundAppStatus::portal_denied(enabled, err),
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        BackgroundAppStatus::fallback(enabled, fallback_message(enabled))
    }
}

fn clear_background_status() {
    #[cfg(target_os = "linux")]
    if is_sandboxed_linux_app() {
        let _ = set_linux_background_status("");
    }
}

#[cfg(target_os = "linux")]
fn is_sandboxed_linux_app() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists()
}

#[cfg(target_os = "linux")]
fn request_linux_background() -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, Value};

    let conn = Connection::session().map_err(|err| err.to_string())?;
    let proxy = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Background",
    )
    .map_err(|err| err.to_string())?;

    let mut options = HashMap::new();
    options.insert(
        "reason",
        Value::from("Keep music playing when the Viby window is closed"),
    );
    options.insert("autostart", Value::from(false));

    let _: OwnedObjectPath = proxy
        .call("RequestBackground", &("", options))
        .map_err(|err| err.to_string())?;

    set_linux_background_status(BACKGROUND_MESSAGE)
}

#[cfg(target_os = "linux")]
fn set_linux_background_status(message: &str) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::Value;

    let conn = Connection::session().map_err(|err| err.to_string())?;
    let proxy = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Background",
    )
    .map_err(|err| err.to_string())?;

    let mut options = HashMap::new();
    options.insert("message", Value::from(message));

    proxy
        .call::<_, _, ()>("SetStatus", &(options))
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_status_reflects_enabled_flag() {
        let status = BackgroundAppStatus::fallback(true, None);

        assert!(status.enabled);
        assert!(status.supported);
        assert_eq!(status.permission, "not-required");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_fallback_provider_is_window_hide() {
        assert_eq!(fallback_provider(), "linux-window-hide");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn non_sandboxed_linux_status_uses_fallback() {
        if is_sandboxed_linux_app() {
            return;
        }

        let status = request_background_status(true);

        assert_eq!(status.provider, "linux-window-hide");
        assert_eq!(status.permission, "not-required");
    }
}

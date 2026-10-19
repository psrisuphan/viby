use tauri::{AppHandle, State};

use crate::NativeWindowTheme;
use crate::audio::player::AudioPlayer;
use crate::discord::DiscordRpcState;
use crate::{DiscordRpcEnabled, DiscordRpcQualityEnabled, RendererLifecycleState};

#[tauri::command]
#[specta::specta]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
#[specta::specta]
pub fn set_discord_rpc_enabled(
    app: AppHandle,
    enabled: bool,
    rpc_enabled: State<'_, DiscordRpcEnabled>,
    rpc: State<'_, DiscordRpcState>,
    player: State<'_, AudioPlayer>,
) {
    crate::set_discord_rpc_enabled(app, enabled, rpc_enabled, rpc, player);
}

#[tauri::command]
#[specta::specta]
pub fn set_discord_rpc_quality_enabled(
    app: AppHandle,
    enabled: bool,
    quality_enabled: State<'_, DiscordRpcQualityEnabled>,
    player: State<'_, AudioPlayer>,
) {
    crate::set_discord_rpc_quality_enabled(app, enabled, quality_enabled, player);
}

#[tauri::command]
#[specta::specta]
pub fn set_frontend_visible(app: AppHandle, visible: bool) {
    crate::set_frontend_visibility(&app, visible);
}

#[tauri::command]
#[specta::specta]
pub fn set_renderer_suspension_enabled(enabled: bool, state: State<'_, RendererLifecycleState>) {
    crate::set_renderer_suspension_enabled(enabled, state);
}

#[tauri::command]
#[specta::specta]
pub fn frontend_ready(app: AppHandle) {
    crate::frontend_ready(app);
}

#[tauri::command]
#[specta::specta]
pub fn show_mini_player(app: AppHandle) -> Result<(), String> {
    crate::show_mini_player(app)
}

#[tauri::command]
#[specta::specta]
pub fn leave_mini_player(app: AppHandle) -> Result<(), String> {
    crate::leave_mini_player(app)
}

#[tauri::command]
#[specta::specta]
pub fn show_theater_mode(app: AppHandle) -> Result<(), String> {
    crate::show_theater_mode(app)
}

#[tauri::command]
#[specta::specta]
pub fn leave_theater_mode(app: AppHandle) -> Result<(), String> {
    crate::leave_theater_mode(app)
}

#[tauri::command]
#[specta::specta]
pub fn is_kde_desktop() -> bool {
    crate::is_kde_desktop()
}

#[tauri::command]
#[specta::specta]
pub fn is_gnome_desktop() -> bool {
    crate::is_gnome_desktop()
}

#[tauri::command]
#[specta::specta]
pub fn set_native_window_theme(app: AppHandle, theme: NativeWindowTheme) -> Result<(), String> {
    crate::set_native_window_theme(app, theme)
}

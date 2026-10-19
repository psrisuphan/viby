#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use tauri::{AppHandle, Manager};
#[cfg(target_os = "linux")]
use zbus::zvariant::Value;

/// A stable failure summary for GNOME playback diagnostics. AppError details
/// can include local media paths, so only the error category is logged.
pub fn playback_failure_diagnostic(error: &crate::error::AppError) -> String {
    let category = match error {
        crate::error::AppError::Database(_) => "database",
        crate::error::AppError::Audio(_) => "audio",
        crate::error::AppError::NotFound(_) => "not_found",
        crate::error::AppError::Io(_) => "io",
        crate::error::AppError::ScanBusy => "busy",
        crate::error::AppError::Other(_) => "other",
    };
    format!("[GnomeSearch] Playback failed ({category})")
}

#[cfg(target_os = "linux")]
pub struct GnomeSearchProvider {
    app: AppHandle,
}

#[cfg(target_os = "linux")]
#[zbus::interface(name = "org.gnome.Shell.SearchProvider2")]
impl GnomeSearchProvider {
    fn get_initial_result_set(&self, terms: Vec<String>) -> Vec<String> {
        let query = terms.join(" ");
        self.search_ids(&query)
    }

    fn get_subsearch_result_set(
        &self,
        _previous_results: Vec<String>,
        terms: Vec<String>,
    ) -> Vec<String> {
        let query = terms.join(" ");
        self.search_ids(&query)
    }

    fn get_result_metadatas(&self, ids: Vec<String>) -> Vec<HashMap<String, Value<'static>>> {
        let db = self.app.state::<crate::library::database::Database>();

        ids.into_iter()
            .filter_map(|id_str| {
                if let Some(track_id) = id_str.strip_prefix("track_")
                    && let Ok(Some(track)) = db.get_track(track_id)
                {
                    let mut map = HashMap::new();
                    map.insert("id".to_string(), Value::from(id_str));
                    map.insert("name".to_string(), Value::from(track.title));
                    map.insert(
                        "description".to_string(),
                        Value::from(format!("{} — {}", track.artist, track.album)),
                    );
                    map.insert("icon".to_string(), Value::from("audio-x-generic"));
                    return Some(map);
                }
                None
            })
            .collect()
    }

    fn activate_result(&self, id: String, _terms: Vec<String>, _timestamp: u32) {
        if let Some(track_id) = id.strip_prefix("track_") {
            let app_handle = self.app.clone();
            let track_id = track_id.to_string();
            let ticket = crate::commands::playback::request_playback_transition();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::commands::playback::play_track_with_ticket(
                    track_id.clone(),
                    app_handle,
                    ticket,
                )
                .await
                {
                    eprintln!("{}", playback_failure_diagnostic(&error));
                }
            });
            crate::show_main_window(&self.app);
        }
    }

    fn launch_search(&self, _terms: Vec<String>, _timestamp: u32) {
        crate::show_main_window(&self.app);
    }
}

#[cfg(target_os = "linux")]
impl GnomeSearchProvider {
    fn search_ids(&self, query: &str) -> Vec<String> {
        if query.trim().is_empty() {
            return Vec::new();
        }
        let db = self.app.state::<crate::library::database::Database>();
        let Ok(tracks) = db.search_tracks(query) else {
            return Vec::new();
        };
        tracks
            .into_iter()
            .take(10)
            .map(|t| format!("track_{}", t.id))
            .collect()
    }
}

#[cfg(target_os = "linux")]
pub fn register_gnome_search_provider(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let provider = GnomeSearchProvider {
            app: app_handle.clone(),
        };
        let Ok(conn) = zbus::connection::Builder::session() else {
            return;
        };
        let Ok(conn) = conn.name("com.viby.app.SearchProvider") else {
            return;
        };
        let Ok(conn) = conn.serve_at("/com/viby/app/SearchProvider", provider) else {
            return;
        };
        let _ = conn.build().await;
    });
}

#[cfg(not(target_os = "linux"))]
pub fn register_gnome_search_provider(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::playback_failure_diagnostic;
    use crate::error::AppError;

    #[test]
    fn playback_diagnostic_omits_private_media_paths() {
        let private_path = "/Users/tester/PrivateLibrary/unreleased.flac";
        let error = AppError::Other(format!("decoder failed while opening {private_path}"));

        let diagnostic = playback_failure_diagnostic(&error);

        assert_eq!(diagnostic, "[GnomeSearch] Playback failed (other)");
        assert!(!diagnostic.contains(private_path));
        assert!(!diagnostic.contains("unreleased.flac"));
    }
}

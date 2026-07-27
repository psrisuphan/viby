#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use tauri::{AppHandle, Manager};
#[cfg(target_os = "linux")]
use zbus::zvariant::Value;

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
        let db = self
            .app
            .state::<Mutex<crate::library::database::Database>>();
        let Ok(db_guard) = db.lock() else {
            return Vec::new();
        };

        ids.into_iter()
            .filter_map(|id_str| {
                if let Some(track_id) = id_str.strip_prefix("track_") {
                    if let Ok(Some(track)) = db_guard.get_track(track_id) {
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
                }
                None
            })
            .collect()
    }

    fn activate_result(&self, id: String, _terms: Vec<String>, _timestamp: u32) {
        if let Some(track_id) = id.strip_prefix("track_") {
            let app_handle = self.app.clone();
            let player = self.app.state::<crate::audio::player::AudioPlayer>();
            let queue = self.app.state::<crate::audio::queue::QueueState>();
            let db = self
                .app
                .state::<Mutex<crate::library::database::Database>>();
            let _ = crate::commands::playback::play_track(
                track_id.to_string(),
                app_handle.clone(),
                player,
                queue,
                db,
            );
            crate::show_main_window(&app_handle);
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
        let db = self
            .app
            .state::<Mutex<crate::library::database::Database>>();
        let Ok(db_guard) = db.lock() else {
            return Vec::new();
        };
        let Ok(tracks) = db_guard.search_tracks(query) else {
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
        if let Ok(conn) = zbus::connection::Builder::session() {
            if let Ok(conn) = conn.name("com.viby.app.SearchProvider") {
                if let Ok(conn) = conn.serve_at("/com/viby/app/SearchProvider", provider) {
                    let _ = conn.build().await;
                }
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn register_gnome_search_provider(_app: &tauri::AppHandle) {}

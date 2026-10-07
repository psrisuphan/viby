use std::hash::{Hash, Hasher};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::ArtworkCache;
use crate::library::database::Database;
use crate::models::Track;

pub(crate) fn mpris_cover_url(app_handle: &AppHandle, track: &Track) -> Option<String> {
    let db = app_handle.state::<Mutex<Database>>();
    let artwork_cache = app_handle.state::<Mutex<ArtworkCache>>();
    let (artwork_bytes, mime_type) =
        crate::commands::library::fetch_raw_artwork(&track.id, &db, &artwork_cache)
            .ok()
            .flatten()?;

    let extension = match mime_type.as_str() {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "jpg",
    };

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    track.album.hash(&mut hasher);
    track.album_artist.hash(&mut hasher);
    let file_name = format!("{:x}.{extension}", hasher.finish());

    let dir = app_handle.path().app_data_dir().ok()?.join("mpris-artwork");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(file_name);
    if !path.exists() {
        std::fs::write(&path, artwork_bytes).ok()?;
        prune_artwork_files(&dir, 96, 64 * 1024 * 1024);
    }

    Some(path_to_file_uri(&path))
}

pub(crate) fn prune_artwork_files(dir: &std::path::Path, max_files: usize, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((modified, metadata.len(), entry.path()))
        })
        .collect();
    files.sort_unstable_by_key(|(modified, _, _)| *modified);
    let mut total_bytes: u64 = files.iter().map(|(_, len, _)| len).sum();
    let mut remaining_files = files.len();
    for (_, len, path) in files {
        if remaining_files <= max_files && total_bytes <= max_bytes {
            break;
        }
        let _ = std::fs::remove_file(path);
        remaining_files -= 1;
        total_bytes = total_bytes.saturating_sub(len);
    }
}

pub(crate) fn path_to_file_uri(path: &std::path::Path) -> String {
    fn encode_segment(input: &str) -> String {
        let mut out = String::new();
        for byte in input.bytes() {
            let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
            if keep {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    let encoded = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::RootDir => None,
            std::path::Component::Normal(part) => Some(encode_segment(&part.to_string_lossy())),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("file:///{encoded}")
}

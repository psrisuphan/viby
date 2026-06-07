use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use crate::library::metadata;
use std::{
    collections::HashMap,
    path::Path as FsPath,
    sync::{Arc, Mutex},
};

/// Maps track_id → (raw_bytes, mime_type). None means artwork was attempted but not found.
pub type ArtworkMap = Arc<Mutex<HashMap<String, Option<(Vec<u8>, String)>>>>;

pub struct ArtworkPort(pub u16);

fn detect_mime(bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x89PNG") {
        "image/png".to_string()
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg".to_string()
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else if bytes.starts_with(b"GIF") {
        "image/gif".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

/// Reads raw artwork bytes for a track: tries embedded art first, then folder images.
pub fn fetch_artwork(file_path: &str) -> Option<(Vec<u8>, String)> {
    let meta = metadata::extract_metadata(file_path).ok()?;

    let bytes = meta.artwork.or_else(|| {
        let parent = FsPath::new(file_path).parent()?;
        let candidates = [
            "cover.jpg", "cover.jpeg", "cover.png",
            "folder.jpg", "folder.jpeg", "folder.png",
            "front.jpg", "front.jpeg", "front.png",
            "Artwork.jpg", "Artwork.jpeg", "Artwork.png",
        ];
        for entry in std::fs::read_dir(parent).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if candidates.iter().any(|c| name == c.to_lowercase()) {
                if let Ok(b) = std::fs::read(entry.path()) {
                    return Some(b);
                }
            }
        }
        None
    })?;

    let mime = detect_mime(&bytes);
    Some((bytes, mime))
}

async fn serve_artwork(Path(track_id): Path<String>, State(map): State<ArtworkMap>) -> impl IntoResponse {
    let guard = map.lock().unwrap();
    match guard.get(&track_id).and_then(|v| v.as_ref()) {
        Some((bytes, mime)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime.clone())],
            bytes.clone(),
        ).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Binds to a random port, starts the artwork HTTP server, and returns the port.
pub async fn serve(listener: std::net::TcpListener, map: ArtworkMap) {
    let tokio_listener = tokio::net::TcpListener::from_std(listener)
        .expect("Failed to convert artwork server listener");
    let app = Router::new()
        .route("/artwork/:track_id", axum::routing::get(serve_artwork))
        .with_state(map);
    axum::serve(tokio_listener, app).await.ok();
}

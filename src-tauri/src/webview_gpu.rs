use std::path::Path;

pub(super) fn gpu_acceleration_enabled(app_data_dir: &Path, default_enabled: bool) -> bool {
    std::fs::read_to_string(app_data_dir.join("gpu_settings.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|settings| settings.get("gpu_acceleration")?.as_bool())
        .unwrap_or(default_enabled)
}

pub(super) fn configure_webview_gpu(enabled: bool) {
    if !enabled {
        eprintln!("[Viby] GPU acceleration disabled for WebView.");
        // Disable GPU acceleration for Linux (WebKit2GTK).
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Disable GPU acceleration for Windows (WebView2).
        unsafe {
            std::env::set_var(
                "TAURI_WEBVIEW_ADDITIONAL_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing",
            );
        }
    } else {
        eprintln!("[Viby] GPU acceleration enabled for WebView.");
    }
}

#[cfg(test)]
mod tests {
    use super::gpu_acceleration_enabled;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "viby-gpu-settings-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create GPU settings test directory");
        path
    }

    #[test]
    fn missing_or_malformed_settings_use_the_platform_default() {
        let directory = temp_dir();
        assert!(gpu_acceleration_enabled(&directory, true));
        assert!(!gpu_acceleration_enabled(&directory, false));

        fs::write(directory.join("gpu_settings.json"), "{").expect("write malformed GPU settings");
        assert!(gpu_acceleration_enabled(&directory, true));
        assert!(!gpu_acceleration_enabled(&directory, false));

        fs::remove_dir_all(directory).expect("remove GPU settings test directory");
    }

    #[test]
    fn explicit_setting_overrides_the_platform_default() {
        let directory = temp_dir();
        let settings = directory.join("gpu_settings.json");

        fs::write(&settings, r#"{"gpu_acceleration":true}"#).expect("write enabled GPU setting");
        assert!(gpu_acceleration_enabled(&directory, false));

        fs::write(&settings, r#"{"gpu_acceleration":false}"#).expect("write disabled GPU setting");
        assert!(!gpu_acceleration_enabled(&directory, true));

        fs::remove_dir_all(directory).expect("remove GPU settings test directory");
    }
}

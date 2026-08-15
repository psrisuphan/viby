use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn validate_file_stem(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || std::path::Path::new(name)
            .file_name()
            .and_then(|part| part.to_str())
            != Some(name)
    {
        return Err("Invalid file name".to_string());
    }
    Ok(name)
}

#[derive(serde::Serialize)]
pub struct TargetCurve {
    pub name: String,
    pub points: Vec<(f32, f32)>,
}

fn headphone_measurements_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("headphone-measurements"))
        .map_err(|error| error.to_string())
}

fn load_headphone_measurements(
    directories: impl IntoIterator<Item = std::path::PathBuf>,
) -> Vec<TargetCurve> {
    let mut curves = std::collections::BTreeMap::new();
    for directory in directories {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let supported = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("txt") || ext.eq_ignore_ascii_case("csv")
                });
            if path.is_file()
                && supported
                && let Ok((name, points)) = read_curve_file(&path)
            {
                curves.entry(name).or_insert(points);
            }
        }
    }
    curves
        .into_iter()
        .map(|(name, points)| TargetCurve { name, points })
        .collect()
}

const MAX_CURVE_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CURVE_POINTS: usize = 100_000;
const MAX_CURVE_NAME_CHARS: usize = 120;

pub struct BoundedCurvePoints(Vec<(f32, f32)>);

impl<'de> serde::Deserialize<'de> for BoundedCurvePoints {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = BoundedCurvePoints;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "at most {MAX_CURVE_POINTS} curve points")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut points =
                    Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(MAX_CURVE_POINTS));
                while let Some(point) = sequence.next_element()? {
                    if points.len() == MAX_CURVE_POINTS {
                        return Err(serde::de::Error::custom("too many curve points"));
                    }
                    points.push(point);
                }
                Ok(BoundedCurvePoints(points))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}

fn validate_measurement_input(name: &str, points: &[(f32, f32)]) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > MAX_CURVE_NAME_CHARS {
        return Err(format!(
            "Measurement name must contain 1 to {MAX_CURVE_NAME_CHARS} characters"
        ));
    }
    if points.is_empty()
        || points.len() > MAX_CURVE_POINTS
        || points.iter().any(|(frequency, gain)| {
            !frequency.is_finite() || *frequency <= 0.0 || !gain.is_finite()
        })
    {
        return Err(format!(
            "Points must contain at most {MAX_CURVE_POINTS} finite gains and positive finite frequencies"
        ));
    }
    Ok(())
}

async fn pick_curve_file(
    app: &tauri::AppHandle,
    title: &str,
    extensions: &[&str],
) -> Result<Option<std::path::PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(title, extensions)
        .set_title(title)
        .pick_file(move |res| {
            let _ = tx.send(res);
        });
    let Some(path) = rx.await.unwrap_or(None) else {
        return Ok(None);
    };
    path.into_path()
        .map(Some)
        .map_err(|_| "Selected file is not a local file".to_string())
}

fn read_curve_file(path: &std::path::Path) -> Result<(String, Vec<(f32, f32)>), String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    if !file
        .metadata()
        .map_err(|e| format!("Failed to inspect file: {e}"))?
        .is_file()
    {
        return Err("Curve must be a file no larger than 2 MB".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CURVE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    if bytes.len() as u64 > MAX_CURVE_FILE_BYTES {
        return Err("Curve must be a file no larger than 2 MB".to_string());
    }
    let content = String::from_utf8(bytes).map_err(|_| "Curve must be valid UTF-8".to_string())?;
    let points = parse_curve_points(&content);
    if points.is_empty() {
        return Err("Invalid file format: no valid frequency-amplitude pairs found".to_string());
    }
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string();
    Ok((name, points))
}

fn parse_curve_points(content: &str) -> Vec<(f32, f32)> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let mut fields = line
                .split(|character: char| character.is_whitespace() || character == ',')
                .filter(|field| !field.is_empty());
            let frequency = fields.next()?.parse::<f32>().ok()?;
            let gain = fields.next()?.parse::<f32>().ok()?;
            (frequency.is_finite() && frequency > 0.0 && gain.is_finite())
                .then_some((frequency, gain))
        })
        .collect()
}

fn is_curve_file(path: &std::path::Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("txt") || ext.eq_ignore_ascii_case("csv"))
}

#[tauri::command]
pub fn get_target_curves(app: tauri::AppHandle) -> Result<Vec<TargetCurve>, String> {
    use std::collections::HashSet;
    use std::fs;
    use tauri::Manager;

    // 1. Start with curves compiled into the binary
    let mut curves = crate::embedded_curves::get_embedded_curves();
    let seen: HashSet<String> = curves.iter().map(|c| c.name.clone()).collect();

    // 2. Supplement with user-imported curves from the user's AppData target-reference folder.
    let target_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("target-reference"))
        .map_err(|e| e.to_string())?;

    if target_dir.exists() {
        let entries = fs::read_dir(&target_dir).map_err(|e| e.to_string())?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !is_curve_file(&path) {
                continue;
            }
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Unknown".to_string());

            // Skip if already embedded (avoids duplicates)
            if seen.contains(&name) {
                continue;
            }

            if let Ok((_, points)) = read_curve_file(&path) {
                curves.push(TargetCurve { name, points });
            }
        }
    }

    curves.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(curves)
}

#[tauri::command]
pub async fn import_target_curve(app: tauri::AppHandle) -> Result<Option<TargetCurve>, String> {
    use std::fs;
    use tauri::Manager;

    let Some(src_path) = pick_curve_file(&app, "Target Curve", &["txt", "csv"]).await? else {
        return Ok(None);
    };
    let (name, points) = read_curve_file(&src_path)?;

    // 2. Resolve destination folder in AppData directory
    let target_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("target-reference"))
        .map_err(|e| e.to_string())?;

    // Create directory if it does not exist
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create target-reference directory: {}", e))?;
    }

    // 3. Save file to destination directory
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "Invalid file name".to_string())?;

    let dest_path = target_dir.join(file_name);
    fs::copy(src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    Ok(Some(TargetCurve { name, points }))
}

#[tauri::command]
pub fn delete_target_curve(name: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;

    // Resolve target-reference folder in AppData directory
    let target_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("target-reference"))
        .map_err(|e| e.to_string())?;

    if !target_dir.exists() {
        return Err("Target reference folder not found".to_string());
    }

    let name = validate_file_stem(&name)?;

    // Find the file with the matching stem
    let txt_path = target_dir.join(format!("{}.txt", name));
    let csv_path = target_dir.join(format!("{}.csv", name));

    if txt_path.exists() {
        fs::remove_file(txt_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else if csv_path.exists() {
        fs::remove_file(csv_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else {
        return Err("Curve file not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn get_headphone_measurements(app: tauri::AppHandle) -> Result<Vec<TargetCurve>, String> {
    use std::path::PathBuf;
    use tauri::Manager;

    #[allow(unused_mut)]
    let mut candidates: Vec<PathBuf> = vec![
        // User-managed files always live in application data.
        headphone_measurements_dir(&app)?,
        // CWD (dev mode)
        std::env::current_dir()
            .map(|p| p.join("headphone-measurements"))
            .unwrap_or_default(),
        // Parent directory (dev mode)
        std::env::current_dir()
            .map(|p| p.join("../headphone-measurements"))
            .unwrap_or_default(),
        // Tauri bundled resources
        app.path()
            .resolve(
                "headphone-measurements",
                tauri::path::BaseDirectory::Resource,
            )
            .unwrap_or_default(),
    ];
    // Linux package fallback (set by PKGBUILD package()). Bundled resources
    // and app data remain the primary cross-platform paths.
    #[cfg(target_os = "linux")]
    candidates.push(PathBuf::from("/usr/share/viby/headphone-measurements"));

    Ok(load_headphone_measurements(candidates))
}

#[tauri::command]
pub async fn import_headphone_measurement(
    app: tauri::AppHandle,
) -> Result<Option<TargetCurve>, String> {
    use std::fs;

    let Some(src_path) = pick_curve_file(&app, "Frequency Response", &["txt", "csv"]).await? else {
        return Ok(None);
    };
    let (name, points) = read_curve_file(&src_path)?;

    // 2. Resolve destination folder
    let measurements_dir = headphone_measurements_dir(&app)?;

    // Create directory if it does not exist
    if !measurements_dir.exists() {
        fs::create_dir_all(&measurements_dir)
            .map_err(|e| format!("Failed to create headphone-measurements directory: {}", e))?;
    }

    // 3. Save file to destination directory
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "Invalid file name".to_string())?;

    let dest_path = measurements_dir.join(file_name);
    fs::copy(src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    Ok(Some(TargetCurve { name, points }))
}

#[tauri::command]
pub fn delete_headphone_measurement(name: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::fs;

    let measurements_dir = headphone_measurements_dir(&app)?;

    if !measurements_dir.exists() {
        return Err("Headphone measurements folder not found".to_string());
    }

    let name = validate_file_stem(&name)?;
    let txt_path = measurements_dir.join(format!("{}.txt", name));
    let csv_path = measurements_dir.join(format!("{}.csv", name));

    if txt_path.exists() {
        fs::remove_file(txt_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else if csv_path.exists() {
        fs::remove_file(csv_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else {
        return Err("Measurement file not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn add_headphone_measurement(
    name: String,
    points: BoundedCurvePoints,
    app: tauri::AppHandle,
) -> Result<TargetCurve, String> {
    use std::fs;

    let points = points.0;
    let name = name.trim();
    validate_measurement_input(name, &points)?;

    let measurements_dir = headphone_measurements_dir(&app)?;

    if !measurements_dir.exists() {
        fs::create_dir_all(&measurements_dir)
            .map_err(|e| format!("Failed to create headphone-measurements directory: {}", e))?;
    }

    let safe_name = name.replace(
        |c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != ' ',
        "_",
    );
    let file_name = format!("{}.txt", safe_name);
    let dest_path = measurements_dir.join(file_name);

    let content = points
        .iter()
        .map(|(f, db)| format!("{} {}", f, db))
        .collect::<Vec<String>>()
        .join("\n");

    fs::write(&dest_path, content)
        .map_err(|e| format!("Failed to write measurement file: {}", e))?;

    Ok(TargetCurve {
        name: safe_name,
        points,
    })
}

#[derive(serde::Serialize)]
pub struct ImportedTextFile {
    pub name: String,
    pub content: String,
}

const MAX_EQ_FILTER_FILE_BYTES: u64 = 2 * 1024 * 1024;

fn read_eq_filter_file(path: &std::path::Path) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to inspect selected file: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_EQ_FILTER_FILE_BYTES {
        return Err("EQ filter file must be no larger than 2 MB".to_string());
    }
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read selected file: {e}"))
}

#[tauri::command]
pub async fn pick_eq_filter_file(
    app: tauri::AppHandle,
) -> Result<Option<ImportedTextFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("AutoEQ Filters", &["txt"])
        .pick_file(move |res| {
            let _ = tx.send(res);
        });
    let Some(path) = rx.await.unwrap_or(None) else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| "Selected file is not a local file".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?
        .to_string();
    let content = read_eq_filter_file(&path)?;
    Ok(Some(ImportedTextFile { name, content }))
}

#[cfg(test)]
mod security_tests {
    use super::{MAX_EQ_FILTER_FILE_BYTES, read_eq_filter_file, validate_file_stem};

    #[test]
    fn curve_names_cannot_escape_their_directory() {
        assert!(validate_file_stem("Harman OE 2018").is_ok());
        for name in ["", ".", "..", "../secret", "folder/file", "folder\\file"] {
            assert!(validate_file_stem(name).is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn rejects_oversized_eq_filter_files_before_reading() {
        let path = std::env::temp_dir().join(format!("viby-eq-{}.txt", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_EQ_FILTER_FILE_BYTES + 1).unwrap();
        assert!(read_eq_filter_file(&path).unwrap_err().contains("2 MB"));
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod curve_tests {
    use super::super::playback::{PeqBandParam, validate_graphic_eq, validate_peq};
    use super::{is_curve_file, parse_curve_points, read_curve_file};

    #[test]
    fn parses_whitespace_and_csv_curves_and_rejects_non_finite_points() {
        let points = parse_curve_points("# curve\n20 1.5\n100,-2\nNaN 0\n200 inf");
        assert_eq!(points, vec![(20.0, 1.5), (100.0, -2.0)]);
    }

    #[test]
    fn rejects_out_of_contract_eq_parameters() {
        assert!(validate_graphic_eq(0.0, &[0.0; 10]).is_ok());
        assert!(validate_graphic_eq(13.0, &[0.0]).is_err());
        assert!(validate_graphic_eq(0.0, &[0.0; 11]).is_err());

        let valid = PeqBandParam {
            enabled: true,
            filter_type: 0,
            freq: 1000.0,
            gain: 0.0,
            q: 1.0,
        };
        assert!(validate_peq(0.0, &[valid]).is_ok());
        assert!(validate_peq(0.0, &[PeqBandParam { q: 0.0, ..valid }]).is_err());
    }

    #[test]
    fn rejects_oversized_curve_files_before_reading() {
        let path = std::env::temp_dir().join(format!("viby-curve-{}.txt", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(super::MAX_CURVE_FILE_BYTES + 1).unwrap();
        assert!(read_curve_file(&path).unwrap_err().contains("2 MB"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn recognizes_supported_curve_extensions() {
        let dir = std::env::temp_dir();
        for extension in ["txt", "CSV"] {
            let path = dir.join(format!("viby-curve-{}.{}", uuid::Uuid::new_v4(), extension));
            std::fs::write(&path, "20 0").unwrap();
            assert!(is_curve_file(&path));
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn rejects_invalid_measurement_sizes_and_names() {
        assert!(super::validate_measurement_input("Valid", &[(20.0, 0.0)]).is_ok());
        assert!(super::validate_measurement_input("", &[(20.0, 0.0)]).is_err());
        assert!(
            super::validate_measurement_input(
                "Valid",
                &vec![(20.0, 0.0); super::MAX_CURVE_POINTS + 1]
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_measurement_points_during_deserialization() {
        let json = serde_json::to_string(&vec![(20.0, 0.0); super::MAX_CURVE_POINTS + 1]).unwrap();
        assert!(serde_json::from_str::<super::BoundedCurvePoints>(&json).is_err());
    }

    #[test]
    fn loads_all_measurement_sources_with_first_source_precedence() {
        let root = std::env::temp_dir().join(format!("viby-sources-{}", uuid::Uuid::new_v4()));
        let user = root.join("user");
        let bundled = root.join("bundled");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(user.join("shared.txt"), "20 1").unwrap();
        std::fs::write(bundled.join("shared.txt"), "20 2").unwrap();
        std::fs::write(bundled.join("other.csv"), "30,3").unwrap();

        let curves = super::load_headphone_measurements([user, bundled]);
        assert_eq!(curves.len(), 2);
        assert_eq!(
            curves
                .iter()
                .find(|curve| curve.name == "shared")
                .unwrap()
                .points,
            vec![(20.0, 1.0)]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

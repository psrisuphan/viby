// =============================================================================
// embedded_curves.rs — Target curves compiled into the binary
// =============================================================================
//
// Each curve file under src-tauri/target-reference/ is embedded via include_str! so that
// the data is baked into the binary at compile time.  No external filesystem
// access is needed to load the shipped curves.
//
// To add a curve, place a .txt file in src-tauri/target-reference/ and add an entry to
// the EMBEDDED_CURVES array below.  The name should match the filename stem.
// =============================================================================

use crate::commands::playback::TargetCurve;

/// A raw embedded curve: filename stem + compile-time string content.
struct EmbeddedCurve {
    pub name: &'static str,
    pub data: &'static str,
}

/// All target curves shipped with the application.
const EMBEDDED_CURVES: &[EmbeddedCurve] = &[
    EmbeddedCurve {
        name: "Harman IE 2019",
        data: include_str!("../target-reference/Harman IE 2019.txt"),
    },
    EmbeddedCurve {
        name: "Harman OE 2018",
        data: include_str!("../target-reference/Harman OE 2018.txt"),
    },
    EmbeddedCurve {
        name: "HiFiEndgame",
        data: include_str!("../target-reference/HiFiEndgame.txt"),
    },
    EmbeddedCurve {
        name: "IEF Preference 2025",
        data: include_str!("../target-reference/IEF Preference 2025.txt"),
    },
    EmbeddedCurve {
        name: "PEQdB Diamond β",
        data: include_str!("../target-reference/PEQdB Diamond Beta.txt"),
    },
];

/// Returns the list of target curves that were compiled into the binary.
pub fn get_embedded_curves() -> Vec<TargetCurve> {
    let mut curves = Vec::with_capacity(EMBEDDED_CURVES.len());

    for ec in EMBEDDED_CURVES {
        let mut points = Vec::new();
        for line in ec.data.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 2
                && let (Ok(freq), Ok(db)) = (parts[0].parse::<f32>(), parts[1].parse::<f32>())
            {
                points.push((freq, db));
            }
        }
        if !points.is_empty() {
            curves.push(TargetCurve {
                name: ec.name.to_string(),
                points,
            });
        }
    }

    curves
}

#[cfg(test)]
mod tests {
    use super::get_embedded_curves;

    #[test]
    fn canonical_distribution_contains_all_embedded_curves() {
        let curves = get_embedded_curves();
        let names: Vec<_> = curves.iter().map(|curve| curve.name.as_str()).collect();

        assert_eq!(curves.len(), 5);
        assert!(names.contains(&"Harman IE 2019"));
        assert!(names.contains(&"Harman OE 2018"));
        assert!(names.contains(&"HiFiEndgame"));
        assert!(names.contains(&"IEF Preference 2025"));
        assert!(names.contains(&"PEQdB Diamond β"));
        assert!(curves.iter().all(|curve| !curve.points.is_empty()));
    }
}

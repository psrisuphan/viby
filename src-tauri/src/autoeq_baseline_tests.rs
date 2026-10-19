use super::{AutoEqBand, AutoEqOptions, AutoEqTargetCurve, run_autoeq_inner};
use serde::Deserialize;

const FIXTURE: &str = include_str!("../tests/fixtures/autoeq_baseline.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaselineFixture {
    baseline_commit: String,
    baseline_platform: String,
    measurement: CurveFixture,
    target: CurveFixture,
    bands_to_optimize: Vec<AutoEqBand>,
    cases: Vec<BaselineCase>,
}

#[derive(Deserialize)]
struct CurveFixture {
    name: String,
    points: Vec<(f32, f32)>,
}

impl CurveFixture {
    fn build(&self) -> AutoEqTargetCurve {
        AutoEqTargetCurve {
            name: self.name.clone(),
            points: self.points.clone(),
        }
    }
}

#[derive(Deserialize)]
struct BaselineCase {
    name: String,
    options: AutoEqOptions,
    expected: ExpectedResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedResult {
    bands: Vec<AutoEqBand>,
    preamp: f32,
    loss: f32,
    max_response_db: f32,
}

fn assert_close(case: &str, field: &str, actual: f32, expected: f32, tolerance: f32) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{case}: {field} expected {expected}, got {actual} (tolerance {tolerance})"
    );
}

#[test]
fn matches_autoeq_baselines_captured_at_accepted_t20a_pin() {
    let fixture: BaselineFixture = serde_json::from_str(FIXTURE).expect("valid AutoEQ fixture");
    assert_eq!(
        fixture.baseline_commit,
        "2bcc8c5c527f2f61a86ba746bb365f43331352db"
    );
    assert_eq!(fixture.baseline_platform, "aarch64-apple-darwin");

    for case in fixture.cases {
        let BaselineCase {
            name,
            options,
            expected,
        } = case;
        let bands = fixture
            .bands_to_optimize
            .iter()
            .map(|band| AutoEqBand {
                enabled: band.enabled,
                filter_type: band.filter_type,
                freq: band.freq,
                gain: band.gain,
                q: band.q,
            })
            .collect();
        let result = run_autoeq_inner(
            fixture.measurement.build(),
            fixture.target.build(),
            bands,
            Some(options),
        )
        .expect("baseline case succeeds");

        assert_eq!(
            result.bands.len(),
            expected.bands.len(),
            "{name}: band count"
        );
        for (index, (actual, expected)) in result.bands.iter().zip(&expected.bands).enumerate() {
            assert_eq!(
                actual.enabled, expected.enabled,
                "{name}: band {index} enabled"
            );
            assert_eq!(
                actual.filter_type, expected.filter_type,
                "{name}: band {index} filter type"
            );
            assert_close(
                &name,
                &format!("band {index} frequency"),
                actual.freq,
                expected.freq,
                1e-4,
            );
            assert_close(
                &name,
                &format!("band {index} gain"),
                actual.gain,
                expected.gain,
                1e-4,
            );
            assert_close(
                &name,
                &format!("band {index} Q"),
                actual.q,
                expected.q,
                1e-4,
            );
        }
        assert_close(&name, "preamp", result.preamp, expected.preamp, 1e-4);
        assert_close(&name, "loss", result.loss, expected.loss, 1e-4);
        assert_close(
            &name,
            "max response dB",
            result.max_response_db,
            expected.max_response_db,
            1e-4,
        );
    }
}

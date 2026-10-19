use super::{AutoEqBand, AutoEqOptions, AutoEqTargetCurve, run_autoeq_inner};
use crate::audio::eq::{BandConfig, response_db_at};
use serde::Deserialize;

const FIXTURE: &str = include_str!("../tests/fixtures/autoeq_baseline.json");
// Match the optimizer's 0.1 dB output precision without requiring identical
// iterative f32 results from different platform math implementations.
const RESPONSE_TOLERANCE_DB: f64 = 0.1;

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

fn maximum_response_difference(
    actual: &[AutoEqBand],
    expected: &[AutoEqBand],
    sample_rate: f64,
) -> f64 {
    if actual
        .iter()
        .chain(expected)
        .any(|band| !band.freq.is_finite() || !band.gain.is_finite() || !band.q.is_finite())
    {
        return f64::INFINITY;
    }
    let configs = |bands: &[AutoEqBand]| {
        bands
            .iter()
            .map(|band| BandConfig {
                enabled: band.enabled,
                filter_type: band.filter_type,
                freq: band.freq as f64,
                gain_db: band.gain as f64,
                q: band.q as f64,
            })
            .collect::<Vec<_>>()
    };
    let actual = configs(actual);
    let expected = configs(expected);
    let mut maximum = 0.0_f64;
    for index in 0..super::K {
        let frequency = 20.0 * 1000.0_f64.powf(index as f64 / (super::K - 1) as f64);
        let difference = (response_db_at(&actual, frequency, 0.0, sample_rate)
            - response_db_at(&expected, frequency, 0.0, sample_rate))
        .abs();
        if !difference.is_finite() {
            return f64::INFINITY;
        }
        maximum = maximum.max(difference);
    }
    maximum
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
        let sample_rate = options.sample_rate.unwrap_or(super::DEFAULT_FS) as f64;
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
            assert!(
                actual.freq.is_finite() && actual.gain.is_finite() && actual.q.is_finite(),
                "{name}: band {index} must be finite"
            );
            if !cfg!(all(target_arch = "aarch64", target_os = "macos")) {
                continue;
            }
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
        let response_difference =
            maximum_response_difference(&result.bands, &expected.bands, sample_rate);
        assert!(
            response_difference <= RESPONSE_TOLERANCE_DB,
            "{name}: response differs by {response_difference} dB (limit {RESPONSE_TOLERANCE_DB} dB); got {result:?}"
        );
        let on_baseline_platform = cfg!(all(target_arch = "aarch64", target_os = "macos"));
        let db_tolerance = if on_baseline_platform { 1e-4 } else { 0.1001 };
        let loss_tolerance = if on_baseline_platform {
            1e-4
        } else {
            expected.loss.abs() * 0.02 + 1e-4
        };
        assert_close(
            &name,
            "preamp",
            result.preamp,
            expected.preamp,
            db_tolerance,
        );
        assert_close(&name, "loss", result.loss, expected.loss, loss_tolerance);
        assert_close(
            &name,
            "max response dB",
            result.max_response_db,
            expected.max_response_db,
            db_tolerance,
        );
    }
}

#[test]
fn response_comparison_accepts_the_observed_linux_q_variation() {
    let fixture: BaselineFixture = serde_json::from_str(FIXTURE).unwrap();
    let mut changed: BaselineFixture = serde_json::from_str(FIXTURE).unwrap();
    changed.cases[0].expected.bands[0].q = 1.58;
    assert!(
        maximum_response_difference(
            &changed.cases[0].expected.bands,
            &fixture.cases[0].expected.bands,
            48000.0,
        ) <= RESPONSE_TOLERANCE_DB
    );
}

#[test]
fn response_comparison_rejects_gain_regressions_and_non_finite_results() {
    let fixture: BaselineFixture = serde_json::from_str(FIXTURE).unwrap();
    let mut changed: BaselineFixture = serde_json::from_str(FIXTURE).unwrap();
    changed.cases[0].expected.bands[0].gain += 1.0;
    assert!(
        maximum_response_difference(
            &changed.cases[0].expected.bands,
            &fixture.cases[0].expected.bands,
            48000.0,
        ) > RESPONSE_TOLERANCE_DB
    );
    changed.cases[0].expected.bands[0].gain = f32::NAN;
    assert!(
        !maximum_response_difference(
            &changed.cases[0].expected.bands,
            &fixture.cases[0].expected.bands,
            48000.0,
        )
        .is_finite()
    );
}

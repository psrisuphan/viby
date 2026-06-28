import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import type { Track, TrackEqOverride } from "../../types";
import { useSettingsStore, EQ_BAND_COUNT } from "../../stores/settingsStore";
import {
	clearTrackEqOverride,
	deleteTrackEqOverride,
	previewTrackEqOverride,
	saveTrackEqOverride,
} from "../../utils/tauri";
import "./TrackGraphicEqModal.css";

const BAND_LABELS = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const GAIN_MIN = -12;
const GAIN_MAX = 12;

function clampGain(value: number) {
	return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(value * 10) / 10));
}

interface Props {
	track: Track;
	trackOverride: TrackEqOverride | null;
	onSaved: (override: TrackEqOverride) => void;
	onDeleted: () => void;
	onClose: () => void;
}

export default function TrackGraphicEqModal({
	track,
	trackOverride,
	onSaved,
	onDeleted,
	onClose,
}: Props) {
	const globalEnabled = useSettingsStore((s) => s.eqEnabled);
	const globalPreamp = useSettingsStore((s) => s.eqPreamp);
	const globalGains = useSettingsStore((s) => s.eqGains);

	const startingProfile = useMemo(
		() => ({
			enabled: trackOverride?.enabled ?? globalEnabled,
			preamp: trackOverride?.preamp_db ?? globalPreamp,
			gains:
				trackOverride?.gains.length === EQ_BAND_COUNT
					? trackOverride.gains
					: globalGains.slice(0, EQ_BAND_COUNT),
		}),
		[trackOverride, globalEnabled, globalPreamp, globalGains],
	);

	const [enabled, setEnabled] = useState(startingProfile.enabled);
	const [preamp, setPreamp] = useState(startingProfile.preamp);
	const [gains, setGains] = useState(startingProfile.gains);

	useEffect(() => {
		previewTrackEqOverride(enabled, preamp, gains).catch((err) =>
			console.error("Failed to preview track EQ:", err),
		);
	}, [enabled, preamp, gains]);

	const restoreAndClose = () => {
		if (trackOverride) {
			previewTrackEqOverride(
				trackOverride.enabled,
				trackOverride.preamp_db,
				trackOverride.gains,
			).catch((err) => console.error("Failed to restore track EQ:", err));
		} else {
			clearTrackEqOverride().catch((err) =>
				console.error("Failed to restore global EQ:", err),
			);
		}
		onClose();
	};

	const save = async () => {
		const saved = await saveTrackEqOverride(track.id, enabled, preamp, gains);
		onSaved(saved);
		onClose();
	};

	const remove = async () => {
		await deleteTrackEqOverride(track.id);
		onDeleted();
		onClose();
	};

	const resetFlat = () => {
		setPreamp(0);
		setGains(Array(EQ_BAND_COUNT).fill(0));
	};

	const setBand = (index: number, value: number) => {
		setGains((current) => {
			const next = current.slice(0, EQ_BAND_COUNT);
			next[index] = clampGain(value);
			return next;
		});
	};

	return (
		<div className="track-eq-backdrop" data-tauri-no-drag>
			<div className="track-eq-modal" role="dialog" aria-modal="true">
				<div className="track-eq-header">
					<div className="track-eq-title-wrap">
						<div className="track-eq-icon">
							<SlidersHorizontal size={17} />
						</div>
						<div>
							<div className="track-eq-title">Track EQ</div>
							<div className="track-eq-subtitle truncate">
								{track.title} · {track.artist}
							</div>
						</div>
					</div>
					<button className="icon-btn" onClick={restoreAndClose} title="Cancel">
						<X size={17} />
					</button>
				</div>

				<label className="track-eq-enable">
					<span>
						<strong>Override global Equalizer</strong>
						<small>Uses a 10-band EQ only for this track.</small>
					</span>
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
					/>
				</label>

				<div className={`track-eq-board${enabled ? "" : " is-disabled"}`}>
					<div className="track-eq-band track-eq-band--preamp">
						<input
							className="track-eq-num"
							type="number"
							min={GAIN_MIN}
							max={GAIN_MAX}
							step="0.1"
							value={preamp}
							disabled={!enabled}
							onChange={(event) => setPreamp(clampGain(Number(event.target.value)))}
						/>
						<input
							className="track-eq-slider"
							type="range"
							min={GAIN_MIN}
							max={GAIN_MAX}
							step="0.1"
							value={preamp}
							disabled={!enabled}
							onChange={(event) => setPreamp(clampGain(Number(event.target.value)))}
						/>
						<div className="track-eq-label">Pre</div>
					</div>
					<div className="track-eq-divider" />
					{BAND_LABELS.map((label, index) => (
						<div className="track-eq-band" key={label}>
							<input
								className="track-eq-num"
								type="number"
								min={GAIN_MIN}
								max={GAIN_MAX}
								step="0.1"
								value={gains[index] ?? 0}
								disabled={!enabled}
								onChange={(event) => setBand(index, Number(event.target.value))}
							/>
							<input
								className="track-eq-slider"
								type="range"
								min={GAIN_MIN}
								max={GAIN_MAX}
								step="0.1"
								value={gains[index] ?? 0}
								disabled={!enabled}
								onChange={(event) => setBand(index, Number(event.target.value))}
							/>
							<div className="track-eq-label">{label}</div>
						</div>
					))}
				</div>

				<div className="track-eq-actions">
					<button className="track-eq-secondary" onClick={resetFlat}>
						Reset flat
					</button>
					{trackOverride && (
						<button className="track-eq-danger" onClick={remove}>
							Remove override
						</button>
					)}
					<button className="track-eq-secondary" onClick={restoreAndClose}>
						Cancel
					</button>
					<button className="track-eq-primary" onClick={save}>
						Save for this track
					</button>
				</div>
			</div>
		</div>
	);
}

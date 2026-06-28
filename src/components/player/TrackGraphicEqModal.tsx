import { useEffect, useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import type { Track, TrackEqOverride } from "../../types";
import { useSettingsStore, EQ_BAND_COUNT } from "../../stores/settingsStore";
import {
	clearTrackEqOverride,
	deleteTrackEqOverride,
	previewTrackEqOverride,
	saveTrackEqOverride,
} from "../../utils/tauri";
import "../ui/EqualizerTab.css";
import "./TrackGraphicEqModal.css";

const BAND_LABELS = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const GAIN_MIN = -12;
const GAIN_MAX = 12;

function clampGain(value: number) {
	return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(value * 10) / 10));
}

function VSlider({
	value,
	disabled,
	accent,
	onChange,
}: {
	value: number;
	disabled?: boolean;
	accent?: boolean;
	onChange: (value: number) => void;
}) {
	const range = GAIN_MAX - GAIN_MIN;
	const pct = ((value - GAIN_MIN) / range) * 100;
	const centerPct = ((0 - GAIN_MIN) / range) * 100;
	const fillBottom = Math.min(pct, centerPct);
	const fillHeight = Math.abs(pct - centerPct);

	const valueFromY = (element: HTMLDivElement, clientY: number) => {
		const rect = element.getBoundingClientRect();
		const t = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
		return clampGain(GAIN_MIN + t * range);
	};

	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		onChange(valueFromY(event.currentTarget, event.clientY));
	};

	const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
		event.preventDefault();
		onChange(valueFromY(event.currentTarget, event.clientY));
	};

	return (
		<div
			className={`eq-vslider${accent ? " eq-vslider--accent" : ""}${disabled ? " is-disabled" : ""}`}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={(event) =>
				event.currentTarget.hasPointerCapture(event.pointerId) &&
				event.currentTarget.releasePointerCapture(event.pointerId)
			}
			onPointerCancel={(event) =>
				event.currentTarget.hasPointerCapture(event.pointerId) &&
				event.currentTarget.releasePointerCapture(event.pointerId)
			}
			onDoubleClick={() => !disabled && onChange(0)}
			title="Drag to adjust · double-click to reset"
		>
			<div className="eq-vslider-area">
				<div className="eq-vslider-track" />
				<div className="eq-vslider-center" style={{ bottom: `${centerPct}%` }} />
				<div
					className="eq-vslider-fill"
					style={{ bottom: `${fillBottom}%`, height: `${fillHeight}%` }}
				/>
				<div className="eq-vslider-thumb" style={{ bottom: `${pct}%` }} />
			</div>
		</div>
	);
}

interface Props {
	track: Track;
	trackOverride: TrackEqOverride | null;
	anchorRect: DOMRect;
	onSaved: (override: TrackEqOverride) => void;
	onDeleted: () => void;
	onClose: () => void;
}

export default function TrackGraphicEqModal({
	track,
	trackOverride,
	anchorRect,
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

	const left = Math.min(
		window.innerWidth - 16,
		Math.max(16, anchorRect.left + anchorRect.width / 2),
	);
	const bottom = window.innerHeight - anchorRect.top + 12;

	return createPortal(
		<div className="track-eq-popover-layer" data-tauri-no-drag>
			<button
				className="track-eq-popover-scrim"
				aria-label="Close Track EQ"
				onClick={restoreAndClose}
			/>
			<div
				className="track-eq-popover"
				role="dialog"
				aria-modal="false"
				style={{ left, bottom }}
			>
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

				<div className={`eq-board track-eq-board${enabled ? "" : " eq-board--disabled"}`}>
					<div className="eq-band track-eq-band--preamp">
						<input
							className="eq-num eq-num--accent"
							type="number"
							min={GAIN_MIN}
							max={GAIN_MAX}
							step="0.1"
							value={preamp}
							disabled={!enabled}
							onChange={(event) => setPreamp(clampGain(Number(event.target.value)))}
						/>
						<VSlider
							value={preamp}
							disabled={!enabled}
							accent
							onChange={setPreamp}
						/>
						<div className="eq-band-label eq-band-label--accent">Pre</div>
					</div>
					<div className="eq-board-divider" />
					{BAND_LABELS.map((label, index) => (
						<div className="eq-band" key={label}>
							<input
								className="eq-num"
								type="number"
								min={GAIN_MIN}
								max={GAIN_MAX}
								step="0.1"
								value={gains[index] ?? 0}
								disabled={!enabled}
								onChange={(event) => setBand(index, Number(event.target.value))}
							/>
							<VSlider
								value={gains[index] ?? 0}
								disabled={!enabled}
								onChange={(value) => setBand(index, value)}
							/>
							<div className="eq-band-label">{label}</div>
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
		</div>,
		document.body,
	);
}

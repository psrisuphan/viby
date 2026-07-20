import { useEffect, useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Music, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import type { Track, TrackEqOverride } from "../../types";
import { useSettingsStore, EQ_BAND_COUNT } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useArtwork } from "../../utils/useArtwork";
import {
	clearTrackEqOverride,
	deleteTrackEqOverride,
	previewTrackEqOverride,
	saveTrackEqOverride,
} from "../../utils/tauri";
import "../ui/EqualizerTab.css";
import "./TrackGraphicEqModal.css";

const BAND_LABELS = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const DB_MARKS = [12, 9, 6, 3, 0, -3, -6, -9, -12];
const GAIN_MIN = -12;
const GAIN_MAX = 12;
const POPOVER_MAX_WIDTH = 500;

function clampGain(value: number) {
	return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(value * 10) / 10));
}

function parseGain(value: string, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? clampGain(parsed) : fallback;
}

function GainInput({ value, disabled, accent, onCommit }: {
	value: number;
	disabled?: boolean;
	accent?: boolean;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft !== null) onCommit(parseGain(draft, value));
		setDraft(null);
	};

	return (
		<input
			className={`eq-num${accent ? " eq-num--accent" : ""}`}
			type="text"
			inputMode="decimal"
			value={draft ?? value}
			disabled={disabled}
			onFocus={(event) => event.currentTarget.select()}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
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
				{DB_MARKS.map((mark) => (
					<div
						className="eq-vslider-mark"
						key={mark}
						style={{ bottom: `${((mark - GAIN_MIN) / range) * 100}%` }}
					/>
				))}
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
	const openSettings = useUiStore((s) => s.openSettings);
	const { artworkUrl } = useArtwork(track.id, `${track.album}||${track.album_artist}`, {
		size: 128,
	});

	const startingProfile = useMemo(
		() => ({
			enabled: trackOverride?.enabled ?? false,
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
	const eqStatus = trackOverride
		? enabled
			? "Overriding global EQ"
			: "Track EQ disabled"
		: enabled
			? "Overriding global EQ"
			: globalEnabled
				? "Using global EQ"
				: "Global EQ disabled";

	useEffect(() => {
		if (!enabled) {
			clearTrackEqOverride().catch((err) =>
				console.error("Failed to restore global EQ:", err),
			);
			return;
		}

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
		if (!enabled) {
			if (trackOverride) {
				await deleteTrackEqOverride(track.id);
				onDeleted();
			}
			onClose();
			return;
		}

		const saved = await saveTrackEqOverride(track.id, enabled, preamp, gains);
		onSaved(saved);
		onClose();
	};

	const openGlobalEq = () => {
		onClose();
		openSettings("equalizer");
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

	const popoverWidth = Math.min(POPOVER_MAX_WIDTH, window.innerWidth - 24);
	const left = Math.min(
		window.innerWidth - popoverWidth / 2 - 12,
		Math.max(popoverWidth / 2 + 12, anchorRect.left + anchorRect.width / 2),
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
					<div className="track-eq-track-identity">
						<div className="track-eq-artwork">
							{artworkUrl ? (
								<img src={artworkUrl} alt="" draggable={false} />
							) : (
								<Music size={20} />
							)}
						</div>
						<div className="track-eq-track-copy">
							<div className="track-eq-overline">Per-track equalizer</div>
							<strong className="track-eq-track-title truncate">{track.title}</strong>
							<span className="track-eq-track-artist truncate">{track.artist}</span>
							<span
								className={`track-eq-status${eqStatus === "Overriding global EQ" ? " is-active" : ""}`}
							>
								{eqStatus}
							</span>
						</div>
					</div>
					<button
						className="icon-btn track-eq-close"
						onClick={restoreAndClose}
						title="Cancel"
					>
						<X size={17} />
					</button>
				</div>

				<div className="track-eq-profile">
					<label className="track-eq-override">
						<span className="track-eq-override-copy">
							<strong>Override global EQ</strong>
							<small>{enabled ? "On" : "Off"}</small>
						</span>
						<span className="track-eq-toggle-switch">
							<input
								aria-label="Override global EQ"
								type="checkbox"
								checked={enabled}
								onChange={(event) => setEnabled(event.target.checked)}
							/>
							<span className="track-eq-toggle-track">
								<span className="track-eq-toggle-thumb" />
							</span>
						</span>
					</label>
				</div>

				{enabled && <div className="track-eq-workspace">
					<div className="track-eq-workspace-header">
						<div>
							<strong>Graphic EQ</strong>
							<span>10 bands · ±12 dB</span>
						</div>
						<button className="track-eq-reset" onClick={resetFlat} title="Reset flat">
							<RotateCcw size={14} />
							Reset
						</button>
					</div>
					<div className="track-eq-board-scroll">
						<div className={`eq-board track-eq-board${enabled ? "" : " eq-board--disabled"}`}>
							<div className="eq-band track-eq-band--preamp">
								<GainInput
									value={preamp}
									disabled={!enabled}
									accent
									onCommit={setPreamp}
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
							<div className="track-eq-db-scale" aria-hidden="true">
								{DB_MARKS.map((mark) => (
									<span className={mark === 0 ? "is-zero" : ""} key={mark}>
										<i />
										{mark === 12
											? "+12 dB"
											: mark === 0
												? "0 dB"
												: mark === -12
													? "-12 dB"
														: ""}
									</span>
								))}
							</div>
							{BAND_LABELS.map((label, index) => (
								<div className="eq-band" key={label}>
									<GainInput
										value={gains[index] ?? 0}
										disabled={!enabled}
										onCommit={(value) => setBand(index, value)}
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
					</div>
				</div>}

				<div className="track-eq-actions">
					<button className="track-eq-settings-link" onClick={openGlobalEq}>
						<SlidersHorizontal size={14} />
						Global EQ settings
					</button>
					<div className="track-eq-action-group">
						<button className="track-eq-secondary" onClick={restoreAndClose}>
							Cancel
						</button>
						<button className="track-eq-primary" onClick={save}>
							{enabled ? "Save profile" : "Done"}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

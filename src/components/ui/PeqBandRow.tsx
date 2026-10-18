import { X } from "lucide-react";

import type { PeqBand } from "../../stores/settingsStore";
import Dropdown from "./Dropdown";
import { DragNumField } from "./EqNumericField";
import { GAIN_MAX, GAIN_MIN } from "./eqConstants";

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const Q_MIN = 0.1;
const Q_MAX = 10;
const FILTER_TYPE_LABELS: Record<number, string> = {
	0: "Peak",
	1: "Lo Shelf",
	2: "Hi Shelf",
	3: "Lo Pass",
	4: "Hi Pass",
};
const FILTER_TYPE_OPTIONS = Object.entries(FILTER_TYPE_LABELS).map(
	([value, label]) => ({ value, label }),
);
const BAND_HUES = [200, 160, 280, 40, 340, 100, 260, 20];
const gainless = (filterType: number) => filterType === 3 || filterType === 4;

// Per-band hue palette (cycles through 8 distinct hues)
export default function PeqBandRow({
	band,
	index,
	disabled,
	canRemove,
	onChange,
	onChangeEnd,
	onRemove,
}: {
	band: PeqBand;
	index: number;
	disabled: boolean;
	canRemove: boolean;
	onChange: (patch: Partial<PeqBand>) => void;
	onChangeEnd?: () => void;
	onRemove: () => void;
}) {
	const noGain = gainless(band.filterType);
	const hue = BAND_HUES[index % BAND_HUES.length];
	const accentColor = `hsl(${hue}, 70%, 60%)`;

	return (
		<div
			className={`eq-band-row${disabled ? " is-disabled" : ""}${!band.enabled ? " eq-band-row--bypassed" : ""}`}
		>
			{/* Color dot & Band number */}
			<div className="eq-band-row-meta">
				<span className="eq-band-row-dot" style={{ background: accentColor }} />
				<span className="eq-band-row-num" style={{ color: accentColor }}>
					{index + 1}
				</span>
			</div>

			{/* Type selector */}
			<Dropdown
				className="eq-band-row-type-dropdown"
				value={String(band.filterType)}
				options={FILTER_TYPE_OPTIONS}
				disabled={disabled || !band.enabled}
				onChange={(value) =>
					onChange({ filterType: Number(value) as PeqBand["filterType"] })
				}
			/>

			{/* Freq */}
			<DragNumField
				value={band.freq}
				min={FREQ_MIN}
				max={FREQ_MAX}
				ariaLabel={`Parametric EQ band ${index + 1} frequency`}
				valueSuffix="Hz"
				disabled={disabled || !band.enabled}
				onCommit={(v) => onChange({ freq: v })}
				onCommitEnd={onChangeEnd}
				logScale
				decimals={0}
				className="eq-band-row-val eq-peq-val-freq"
			/>

			{/* Gain */}
			<DragNumField
				value={noGain ? 0 : band.gain}
				min={GAIN_MIN}
				max={GAIN_MAX}
				ariaLabel={`Parametric EQ band ${index + 1} gain`}
				valueSuffix="dB"
				step={0.1}
				disabled={disabled || !band.enabled || noGain}
				onCommit={(v) => onChange({ gain: v })}
				resetValue={0}
				className={`eq-band-row-val eq-peq-val-gain${noGain ? " eq-peq-dimmed" : ""}`}
			/>

			{/* Q */}
			<DragNumField
				value={band.q}
				min={Q_MIN}
				max={Q_MAX}
				ariaLabel={`Parametric EQ band ${index + 1} Q`}
				valueSuffix="Q"
				disabled={disabled || !band.enabled}
				onCommit={(v) => onChange({ q: v })}
				resetValue={1}
				className="eq-band-row-val eq-peq-val-q"
			/>

			{/* Bypass */}
			<div className="eq-band-row-bypass-wrap">
				<input
					type="checkbox"
					className="eq-peq-check"
					checked={band.enabled}
					disabled={disabled}
					onChange={(e) => onChange({ enabled: e.target.checked })}
					title="Enable / bypass"
				/>
			</div>

			{/* Remove */}
			<button
				className="eq-band-row-remove"
				disabled={disabled || !canRemove}
				onClick={onRemove}
				title="Remove"
			>
				<X size={11} />
			</button>
		</div>
	);
}

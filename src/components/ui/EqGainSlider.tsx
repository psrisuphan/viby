import { useRef } from "react";
import AccessibleSlider from "./AccessibleSlider";

const DB_MARKS = [12, 9, 6, 3, 0, -3, -6, -9, -12];

interface EqGainSliderProps {
	value: number;
	min?: number;
	max?: number;
	label: string;
	disabled?: boolean;
	accent?: boolean;
	onChange: (value: number) => void;
}

export default function EqGainSlider({
	value,
	min = -12,
	max = 12,
	label,
	disabled,
	accent,
	onChange,
}: EqGainSliderProps) {
	const areaRef = useRef<HTMLDivElement>(null);
	const range = max - min;
	const pct = ((value - min) / range) * 100;
	const centerPct = ((0 - min) / range) * 100;
	const fillBottom = Math.min(pct, centerPct);
	const fillHeight = Math.abs(pct - centerPct);

	return (
		<AccessibleSlider
			className={`eq-vslider${accent ? " eq-vslider--accent" : ""}${disabled ? " is-disabled" : ""}`}
			orientation="vertical"
			value={value}
			min={min}
			max={max}
			step={0.1}
			pageStep={1.2}
			ariaLabel={label}
			ariaValueText={`${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`}
			disabled={disabled}
			getPointerBounds={() => areaRef.current?.getBoundingClientRect()}
			onValueChange={onChange}
			onDoubleClick={!disabled ? () => onChange(0) : undefined}
			title="Drag to adjust · double-click to reset"
		>
			<div className="eq-vslider-area" ref={areaRef} aria-hidden="true">
				{DB_MARKS.map((mark) => (
					<div className="eq-vslider-mark" key={mark} style={{ bottom: `${((mark - min) / range) * 100}%` }} />
				))}
				<div className="eq-vslider-track" />
				<div className="eq-vslider-center" style={{ bottom: `${centerPct}%` }} />
				<div className="eq-vslider-fill" style={{ bottom: `${fillBottom}%`, height: `${fillHeight}%` }} />
				<div className="eq-vslider-thumb" style={{ bottom: `${pct}%` }} />
			</div>
		</AccessibleSlider>
	);
}

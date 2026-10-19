import { useRef } from "react";

import AccessibleSlider from "./AccessibleSlider";

interface EqHorizontalGainSliderProps {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  label: string;
  onChange: (value: number) => void;
}

export default function EqHorizontalGainSlider({
  value,
  min,
  max,
  disabled,
  label,
  onChange,
}: EqHorizontalGainSliderProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const range = max - min;
  const pct = ((value - min) / range) * 100;
  const centerPct = ((0 - min) / range) * 100;
  const fillLeft = Math.min(pct, centerPct);
  const fillWidth = Math.abs(pct - centerPct);

  return (
    <AccessibleSlider
      className={`eq-hslider${disabled ? " is-disabled" : ""}`}
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
      <div className="eq-hslider-area" ref={areaRef} aria-hidden="true">
        <div className="eq-hslider-track" />
        <div className="eq-hslider-center" style={{ left: `${centerPct}%` }} />
        <div
          className="eq-hslider-fill"
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />
        <div className="eq-hslider-thumb" style={{ left: `${pct}%` }} />
      </div>
    </AccessibleSlider>
  );
}

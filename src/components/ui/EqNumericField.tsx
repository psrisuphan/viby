import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { getSliderKeyboardValue } from "./sliderMath";

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

export function NumField({
	value,
	min,
	max,
	disabled,
	onCommit,
	className,
}: {
	value: number;
	min: number;
	max: number;
	disabled?: boolean;
	onCommit: (v: number) => void;
	className?: string;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const display = draft ?? value.toFixed(2);

	const commit = () => {
		if (draft !== null) {
			const parsed = parseFloat(draft);
			if (!isNaN(parsed)) onCommit(round2(clamp(parsed, min, max)));
			setDraft(null);
		}
	};

	return (
		<input
			className={`eq-num${className ? ` ${className}` : ""}`}
			type="text"
			inputMode="decimal"
			value={display}
			disabled={disabled}
			onFocus={(e) => e.currentTarget.select()}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
		/>
	);
}

// Drag-to-adjust numeric display. Drag ↕ to change value; click to type; double-click to reset.
// Used for PEQ band parameters where a full-height VSlider won't fit.
export function DragNumField({
	value,
	min,
	max,
	disabled,
	onCommit,
	onCommitEnd,
	className,
	logScale,
	resetValue,
	decimals = 2,
	ariaLabel,
	valueSuffix,
	step = decimals === 0 ? 1 : 0.01,
}: {
	value: number;
	min: number;
	max: number;
	disabled?: boolean;
	onCommit: (v: number) => void;
	onCommitEnd?: () => void;
	className?: string;
	logScale?: boolean;
	resetValue?: number;
	decimals?: number;
	ariaLabel: string;
	valueSuffix?: string;
	step?: number;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const drag = useRef<{
		startY: number;
		startVal: number;
		moved: boolean;
	} | null>(null);

	// px of drag to cover the full range (shift = 10× finer)
	const linearSens = (max - min) / 150;
	const logSens = 1 / 100; // 100px per octave

	const applyDrag = (startVal: number, dy: number, fine: boolean) => {
		const scale = fine ? 0.1 : 1;
		const next = logScale
			? startVal * 2 ** (dy * logSens * scale)
			: startVal + dy * linearSens * scale;
		return round2(clamp(next, min, max));
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		e.preventDefault();
		e.currentTarget.focus({ preventScroll: true });
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { startY: e.clientY, startVal: value, moved: false };
	};

	const onSliderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (disabled) return;
		if (event.key === "Enter") {
			event.preventDefault();
			setDraft(value.toFixed(decimals));
			setEditing(true);
			return;
		}
		// Modified navigation is consumed here so the focused EQ control cannot also trigger a
		// global volume or track shortcut. The slider value still changes only on unmodified keys.
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			if (["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown"].includes(event.key)) {
				event.preventDefault();
			}
			return;
		}
		let next: number | null;
		if (logScale && ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
			const factor = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1.01
				: event.key === "ArrowLeft" || event.key === "ArrowDown" ? 1 / 1.01
				: event.key === "PageUp" ? 2 : 0.5;
			next = round2(clamp(value * factor, min, max));
		} else {
			next = getSliderKeyboardValue(event.key, value, min, max, step, Math.max(step * 10, (max - min) / 10));
		}
		if (next === null) return;
		event.preventDefault();
		if (next !== value) {
			onCommit(next);
			onCommitEnd?.();
		}
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		e.preventDefault();
		const dy = drag.current.startY - e.clientY; // up = positive = increase
		if (!drag.current.moved && Math.abs(dy) > 3) drag.current.moved = true;
		if (drag.current.moved)
			onCommit(applyDrag(drag.current.startVal, dy, e.shiftKey));
	};

	const onPointerUp = () => {
		if (!drag.current) return;
		const wasDrag = drag.current.moved;
		drag.current = null;
		if (!wasDrag && !disabled) {
			setDraft(value.toFixed(decimals));
			setEditing(true);
		} else if (wasDrag && onCommitEnd) {
			onCommitEnd();
		}
	};

	const onPointerCancel = () => {
		if (drag.current?.moved) onCommitEnd?.();
		drag.current = null;
	};

	const commitDraft = () => {
		const parsed = parseFloat(draft);
		if (!isNaN(parsed)) {
			onCommit(round2(clamp(parsed, min, max)));
			if (onCommitEnd) onCommitEnd();
		}
		setEditing(false);
	};

	if (editing) {
		return (
			<input
				autoFocus
				className={`eq-num${className ? ` ${className}` : ""}`}
				type="text"
				aria-label={ariaLabel}
				inputMode="decimal"
				value={draft}
				onFocus={(e) => e.currentTarget.select()}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commitDraft}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") setEditing(false);
				}}
			/>
		);
	}

	return (
		<div
			className={`eq-num eq-num--drag${className ? ` ${className}` : ""}${disabled ? " eq-num--drag-disabled" : ""}`}
			role="slider"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={value}
			aria-valuetext={`${value.toFixed(decimals)}${valueSuffix ? ` ${valueSuffix}` : ""}`}
			aria-disabled={disabled || undefined}
			tabIndex={disabled ? -1 : 0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onKeyDown={onSliderKeyDown}
			onDoubleClick={() => {
				if (!disabled && resetValue !== undefined) onCommit(resetValue);
			}}
			title="Drag or use arrow keys · Page Up/Down for larger steps · click to type · double-click to reset"
		>
			{value.toFixed(decimals)}
		</div>
	);
}

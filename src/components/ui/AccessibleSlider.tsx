import {
	forwardRef,
	useRef,
	useState,
	type FocusEventHandler,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import {
	getSliderKeyboardValue,
	normalizeSliderValue,
} from "./sliderMath";
import "./AccessibleSlider.css";

interface AccessibleSliderProps {
	className: string;
	orientation?: "horizontal" | "vertical";
	value: number;
	min: number;
	max: number;
	step?: number;
	pageStep?: number;
	ariaLabel: string;
	ariaValueText?: string;
	disabled?: boolean;
	title?: string;
	getPointerBounds?: () => DOMRect | undefined;
	getHoverValueText?: (value: number) => string;
	onValueChange: (value: number) => void;
	onValueCommit?: (value: number) => void;
	onValueCancel?: (startingValue: number) => void;
	onInteractionChange?: (active: boolean) => void;
	onDoubleClick?: () => void;
	onFocus?: FocusEventHandler<HTMLDivElement>;
	onBlur?: FocusEventHandler<HTMLDivElement>;
	children: ReactNode;
}

const AccessibleSlider = forwardRef<HTMLDivElement, AccessibleSliderProps>(
	function AccessibleSlider(
		{
			className,
			orientation = "horizontal",
			value,
			min,
			max,
			step = 1,
			pageStep = Math.max(step * 10, (max - min) / 10),
			ariaLabel,
			ariaValueText,
			disabled = false,
			title,
			getPointerBounds,
			getHoverValueText,
			onValueChange,
			onValueCommit,
			onValueCancel,
			onInteractionChange,
			onDoubleClick,
			onFocus,
			onBlur,
			children,
		},
		ref,
	) {
		const draggingRef = useRef(false);
		const activePointerIdRef = useRef<number | null>(null);
		const startingPointerValueRef = useRef(value);
		const lastPointerValueRef = useRef(value);
		const keyboardValueRef = useRef<number | null>(null);
		const [hoverValue, setHoverValue] = useState<number | null>(null);

		const valueFromPointer = (event: PointerEvent<HTMLDivElement>) => {
			const rect = getPointerBounds?.() ?? event.currentTarget.getBoundingClientRect();
			const span = orientation === "vertical" ? rect.height : rect.width;
			if (span <= 0) return value;
			const rawRatio = orientation === "vertical"
				? (rect.bottom - event.clientY) / span
				: (event.clientX - rect.left) / span;
			const ratio = Math.min(1, Math.max(0, rawRatio));
			return normalizeSliderValue(min + ratio * (max - min), min, max, step);
		};

		const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
			if (disabled || event.button !== 0 || max <= min) return;
			event.preventDefault();
			event.currentTarget.focus({ preventScroll: true });
			event.currentTarget.setPointerCapture(event.pointerId);
			draggingRef.current = true;
			activePointerIdRef.current = event.pointerId;
			startingPointerValueRef.current = value;
			onInteractionChange?.(true);
			const next = valueFromPointer(event);
			lastPointerValueRef.current = next;
			onValueChange(next);
		};

		const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
			if (draggingRef.current) {
				if (
					event.pointerId !== activePointerIdRef.current ||
					!event.currentTarget.hasPointerCapture(event.pointerId)
				) return;
				event.preventDefault();
				if (disabled) return;
				const next = valueFromPointer(event);
				lastPointerValueRef.current = next;
				onValueChange(next);
				return;
			}

			if (!disabled && getHoverValueText) setHoverValue(valueFromPointer(event));
		};

		const finishPointer = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
			if (!draggingRef.current || event.pointerId !== activePointerIdRef.current) return;
			const wasCancelled = cancelled || disabled;
			draggingRef.current = false;
			activePointerIdRef.current = null;
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			if (!wasCancelled) {
				lastPointerValueRef.current = valueFromPointer(event);
				onValueChange(lastPointerValueRef.current);
				onInteractionChange?.(false);
				onValueCommit?.(lastPointerValueRef.current);
			} else {
				onValueCancel?.(startingPointerValueRef.current);
				onInteractionChange?.(false);
			}
		};

		const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
			if (
				disabled || max <= min || event.altKey || event.ctrlKey ||
				event.metaKey || event.shiftKey
			) return;
			const current = keyboardValueRef.current ?? value;
			const next = getSliderKeyboardValue(event.key, current, min, max, step, pageStep);
			if (next === null) return;
			event.preventDefault();
			keyboardValueRef.current = next;
			if (next !== current) {
				onValueChange(next);
				onValueCommit?.(next);
			}
		};

		const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
			if (["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
				keyboardValueRef.current = null;
			}
		};

		return (
			<div
				ref={ref}
				className={`accessible-slider ${className}`}
				role="slider"
				aria-label={ariaLabel}
				aria-orientation={orientation}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={value}
				aria-valuetext={ariaValueText ?? String(value)}
				aria-disabled={disabled || undefined}
				tabIndex={disabled ? -1 : 0}
				title={title}
				onPointerEnter={(event) => {
					if (!disabled && getHoverValueText) setHoverValue(valueFromPointer(event));
				}}
				onPointerLeave={() => {
					if (!draggingRef.current) setHoverValue(null);
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={(event) => finishPointer(event, false)}
				onPointerCancel={(event) => finishPointer(event, true)}
				onLostPointerCapture={(event) => finishPointer(event, true)}
				onKeyDown={handleKeyDown}
				onKeyUp={handleKeyUp}
				onBlur={(event) => {
					keyboardValueRef.current = null;
					onBlur?.(event);
				}}
				onFocus={onFocus}
				onDoubleClick={disabled || max <= min ? undefined : onDoubleClick}
			>
				{children}
				{getHoverValueText && hoverValue !== null && !disabled && (
					<span
						className="accessible-slider__hover-preview"
						aria-hidden="true"
						style={{
							left: `${Math.min(97, Math.max(3, ((hoverValue - min) / (max - min)) * 100))}%`,
						}}
					>
						{getHoverValueText(hoverValue)}
					</span>
				)}
			</div>
		);
	},
);

AccessibleSlider.displayName = "AccessibleSlider";

export default AccessibleSlider;

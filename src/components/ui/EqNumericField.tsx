import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

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
type DragSession = {
  pointerId: number;
  startY: number;
  startVal: number;
  lastVal: number;
  moved: boolean;
};

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
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const drag = useRef<DragSession | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const resetGestureArmedRef = useRef(false);
  const resetGestureDraftRef = useRef<string | null>(null);
  const editIsActiveRef = useRef(false);
  const restoreFocusAfterEditRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  const onCommitEndRef = useRef(onCommitEnd);
  onCommitRef.current = onCommit;
  onCommitEndRef.current = onCommitEnd;
  const finishDragRef = useRef<
    (pointerId?: number, cancel?: boolean) => DragSession | null
  >(() => null);
  const finishEditRef = useRef<
    (commit: boolean, restoreFocus?: boolean) => void
  >(() => {});

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

  const finishDrag = (
    pointerId?: number,
    cancel = false,
  ): DragSession | null => {
    const session = drag.current;
    if (
      !session ||
      (pointerId !== undefined && pointerId !== session.pointerId)
    )
      return null;
    drag.current = null;
    const slider = sliderRef.current;
    try {
      if (slider?.hasPointerCapture(session.pointerId)) {
        slider.releasePointerCapture(session.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    if (session.moved) {
      if (cancel && session.lastVal !== session.startVal) {
        onCommitRef.current(session.startVal);
      }
      onCommitEndRef.current?.();
    }
    return session;
  };
  finishDragRef.current = finishDrag;

  const finishEdit = (commit: boolean, restoreFocus = false) => {
    if (!editIsActiveRef.current) return;
    editIsActiveRef.current = false;
    resetGestureArmedRef.current = false;
    resetGestureDraftRef.current = null;
    if (commit) {
      const parsed = parseFloat(draftRef.current);
      if (Number.isFinite(parsed)) {
        onCommitRef.current(round2(clamp(parsed, min, max)));
        onCommitEndRef.current?.();
      }
    }
    setEditing(false);
    if (restoreFocus) restoreFocusAfterEditRef.current = true;
  };
  finishEditRef.current = finishEdit;

  useLayoutEffect(() => {
    if (!disabled) return;
    finishDragRef.current(undefined, true);
    finishEditRef.current(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (editing || !restoreFocusAfterEditRef.current) return;
    restoreFocusAfterEditRef.current = false;
    sliderRef.current?.focus({ preventScroll: true });
  }, [editing]);

  useLayoutEffect(
    () => () => {
      finishDragRef.current(undefined, true);
      finishEditRef.current(false);
    },
    [],
  );

  const beginEdit = (initialValue: number, pointerInitiated = false) => {
    if (disabled) return;
    editIsActiveRef.current = true;
    const initialDraft = initialValue.toFixed(decimals);
    draftRef.current = initialDraft;
    setDraft(initialDraft);
    resetGestureArmedRef.current =
      pointerInitiated && resetValue !== undefined;
    resetGestureDraftRef.current =
      pointerInitiated && resetValue !== undefined ? initialDraft : null;
    setEditing(true);
  };

  const resetToDefault = () => {
    if (disabled || resetValue === undefined) return;
    if (editIsActiveRef.current) finishEditRef.current(false, true);
    onCommitRef.current(resetValue);
    onCommitEndRef.current?.();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || drag.current || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    const session: DragSession = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startVal: value,
      lastVal: value,
      moved: false,
    };
    drag.current = session;
    e.currentTarget.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The session still owns this pointer; finish/cancel handlers can clean it up if
      // this browser rejects capture for a synthetic or already-released pointer.
    }
  };

  const onSliderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "Enter") {
      event.preventDefault();
      beginEdit(value);
      return;
    }
    // Modified navigation belongs to this control, so global volume and track shortcuts cannot
    // also consume Ctrl/Meta/Alt/Shift+Arrow from a focused numeric slider.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      if (
        ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
      }
      return;
    }
    let next: number | null;
    if (
      logScale &&
      [
        "ArrowRight",
        "ArrowUp",
        "ArrowLeft",
        "ArrowDown",
        "PageUp",
        "PageDown",
      ].includes(event.key)
    ) {
      const factor =
        event.key === "ArrowRight" || event.key === "ArrowUp"
          ? 1.01
          : event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? 1 / 1.01
            : event.key === "PageUp"
              ? 2
              : 0.5;
      next = round2(clamp(value * factor, min, max));
    } else {
      next = getSliderKeyboardValue(
        event.key,
        value,
        min,
        max,
        step,
        Math.max(step * 10, (max - min) / 10),
      );
    }
    if (next === null) return;
    event.preventDefault();
    if (next !== value) {
      onCommit(next);
      onCommitEnd?.();
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    if (!session || e.pointerId !== session.pointerId) return;
    e.preventDefault();
    const dy = session.startY - e.clientY; // up = positive = increase
    if (!session.moved && Math.abs(dy) > 3) session.moved = true;
    if (session.moved) {
      const next = applyDrag(session.startVal, dy, e.shiftKey);
      session.lastVal = next;
      onCommitRef.current(next);
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const session = finishDragRef.current(e.pointerId, false);
    if (session && !session.moved) beginEdit(session.startVal, true);
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    finishDragRef.current(e.pointerId, true);
  };

  const onLostPointerCapture = (e: PointerEvent<HTMLDivElement>) => {
    finishDragRef.current(e.pointerId, true);
  };

  return (
    <div style={{ display: "contents" }}
      onClick={(event) => {
        const isInputClick = event.target instanceof HTMLInputElement;
        if (event.detail === 1) {
          // The opening click can still target the slider that was just replaced.
          // A later first click on the already-open input starts text selection,
          // so it must disarm the reset gesture.
          if (isInputClick) {
            resetGestureArmedRef.current = false;
            resetGestureDraftRef.current = null;
          }
          return;
        }
        if (event.detail !== 2) return;

        const resetGestureArmed = resetGestureArmedRef.current;
        const initialDraft = resetGestureDraftRef.current;
        resetGestureArmedRef.current = false;
        resetGestureDraftRef.current = null;
        if (
          isInputClick &&
          resetGestureArmed &&
          initialDraft !== null &&
          draftRef.current === initialDraft
        ) {
          resetToDefault();
        }
      }}
      onKeyDown={(event) => {
        if (
          editing ||
          disabled ||
          resetValue === undefined ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.key.toLowerCase() !== "r"
        )
          return;
        event.preventDefault();
        resetToDefault();
      }}
    >
      {editing ? (
        <input
          autoFocus
          className={`eq-num${className ? ` ${className}` : ""}`}
          type="text"
          aria-label={ariaLabel}
          inputMode="decimal"
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishEditRef.current(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finishEditRef.current(true, true);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              finishEditRef.current(false, true);
            }
          }}
        />
      ) : (
        <div
          ref={sliderRef}
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
          onLostPointerCapture={onLostPointerCapture}
          onKeyDown={onSliderKeyDown}
          title={
            resetValue === undefined
              ? "Drag or use arrow keys · Page Up/Down for larger steps · click to type"
              : "Drag or use arrow keys · Page Up/Down for larger steps · click to type · double-click or press R to reset"
          }
        >
          {value.toFixed(decimals)}
        </div>
      )}
    </div>
  );
}

export interface SliderPointerSession {
	pointerId: number | null;
	startingValue: number;
}

interface SliderPointerCallbacks {
	onValueChange: (value: number) => void;
	onValueCommit?: (value: number) => void;
	onValueCancel?: (startingValue: number) => void;
	onInteractionChange?: (active: boolean) => void;
}

export function startSliderPointerSession(
	session: SliderPointerSession,
	pointerId: number,
	startingValue: number,
): boolean {
	if (session.pointerId !== null) return false;
	session.pointerId = pointerId;
	session.startingValue = startingValue;
	return true;
}

export function finishSliderPointerSession(
	session: SliderPointerSession,
	pointerId: number,
	finish: { kind: "commit"; value: number } | { kind: "cancel" | "release" },
	callbacks: SliderPointerCallbacks,
): boolean {
	if (session.pointerId !== pointerId) return false;
	const startingValue = session.startingValue;
	session.pointerId = null;

	if (finish.kind === "commit") {
		callbacks.onValueChange(finish.value);
		callbacks.onInteractionChange?.(false);
		callbacks.onValueCommit?.(finish.value);
	} else {
		if (finish.kind === "cancel") callbacks.onValueCancel?.(startingValue);
		callbacks.onInteractionChange?.(false);
	}
	return true;
}

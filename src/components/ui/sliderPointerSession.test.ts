import { describe, expect, it, vi } from "vitest";
import {
	finishSliderPointerSession,
	startSliderPointerSession,
	type SliderPointerSession,
} from "./sliderPointerSession";

function createSession(): SliderPointerSession {
	return { pointerId: null, startingValue: 25 };
}

describe("accessible slider pointer sessions", () => {
	it("keeps the first pointer as owner and ignores other pointers", () => {
		const session = createSession();
		const events: string[] = [];
		const callbacks = {
			onValueChange: vi.fn((value: number) => events.push(`change:${value}`)),
			onValueCommit: vi.fn((value: number) => events.push(`commit:${value}`)),
			onValueCancel: vi.fn((value: number) => events.push(`cancel:${value}`)),
			onInteractionChange: vi.fn((active: boolean) => events.push(`interaction:${active}`)),
		};

		expect(startSliderPointerSession(session, 11, 25)).toBe(true);
		callbacks.onInteractionChange(true);
		expect(startSliderPointerSession(session, 22, 40)).toBe(false);
		expect(finishSliderPointerSession(session, 22, { kind: "commit", value: 90 }, callbacks)).toBe(false);
		expect(session.pointerId).toBe(11);
		expect(finishSliderPointerSession(session, 11, { kind: "commit", value: 63 }, callbacks)).toBe(true);

		expect(session.pointerId).toBeNull();
		expect(events).toEqual(["interaction:true", "change:63", "interaction:false", "commit:63"]);
		expect(callbacks.onValueCancel).not.toHaveBeenCalled();
	});

	it("cancels on capture loss and restores the start before clearing interaction", () => {
		const session = createSession();
		const events: string[] = [];
		const callbacks = {
			onValueChange: vi.fn((value: number) => events.push(`change:${value}`)),
			onValueCommit: vi.fn((value: number) => events.push(`commit:${value}`)),
			onValueCancel: vi.fn((value: number) => events.push(`cancel:${value}`)),
			onInteractionChange: vi.fn((active: boolean) => events.push(`interaction:${active}`)),
		};

		startSliderPointerSession(session, 7, 25);
		callbacks.onInteractionChange(true);
		expect(finishSliderPointerSession(session, 7, { kind: "cancel" }, callbacks)).toBe(true);

		expect(session.pointerId).toBeNull();
		expect(events).toEqual(["interaction:true", "cancel:25", "interaction:false"]);
		expect(callbacks.onValueCommit).not.toHaveBeenCalled();
	});

	it("clears interaction on unmount release without committing a value", () => {
		const session = createSession();
		const onInteractionChange = vi.fn();
		const onValueCancel = vi.fn();
		const onValueCommit = vi.fn();
		const callbacks = {
			onValueChange: vi.fn(),
			onInteractionChange,
			onValueCancel,
			onValueCommit,
		};

		startSliderPointerSession(session, 3, 25);
		onInteractionChange(true);
		expect(finishSliderPointerSession(session, 3, { kind: "release" }, callbacks)).toBe(true);

		expect(session.pointerId).toBeNull();
		expect(onInteractionChange.mock.calls).toEqual([[true], [false]]);
		expect(onValueCancel).not.toHaveBeenCalled();
		expect(onValueCommit).not.toHaveBeenCalled();
	});
});

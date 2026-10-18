import { mockPlaybackState, mockQueue } from "./mocks";

export type UnlistenFn = () => void;

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

export function dispatchMockEvent(event: string, payload: unknown) {
	for (const listener of listeners.get(event) ?? []) listener({ payload });
}

export async function listen<T>(
	event: string,
	handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
	const callback = handler as (event: { payload: unknown }) => void;
	const eventListeners = listeners.get(event) ?? new Set();
	eventListeners.add(callback);
	listeners.set(event, eventListeners);
	setTimeout(() => {
		if (event === "playback-state") {
			callback({ payload: mockPlaybackState });
		} else if (event === "queue-changed") {
			callback({ payload: mockQueue });
		} else if (event === "queue-position-changed") {
			callback({ payload: { current_index: 0 } });
		}
	}, 50);
	return () => {
		eventListeners.delete(callback);
		if (eventListeners.size === 0) listeners.delete(event);
	};
}


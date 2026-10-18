import { mockPlaybackState, mockQueue } from "./mocks";

export type UnlistenFn = () => void;

type BrowserEventHandler = (payload: unknown) => void;
const browserEventHandlers = new Map<string, Set<BrowserEventHandler>>();

export function emitBrowserTestEvent<T>(event: string, payload: T): void {
	for (const handler of browserEventHandlers.get(event) ?? []) {
		handler(payload);
	}
}

function initialEventPayload(event: string): unknown {
	if (event === "playback-state") return mockPlaybackState;
	if (event === "queue-changed") return mockQueue;
	if (event === "queue-position-changed") return { current_index: 0 };
	return undefined;
}

export async function listen<T>(
	event: string,
	handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
	const handlerSet = browserEventHandlers.get(event) ?? new Set<BrowserEventHandler>();
	const registeredHandler: BrowserEventHandler = (payload) =>
		handler({ payload: payload as T });
	handlerSet.add(registeredHandler);
	browserEventHandlers.set(event, handlerSet);

	// Initial state goes only to the listener that just subscribed, and the timer is cancelled on unlisten.
	const initialPayload = initialEventPayload(event);
	const initialTimer =
		initialPayload === undefined
			? null
			: setTimeout(() => {
					if (handlerSet.has(registeredHandler)) registeredHandler(initialPayload);
				}, 50);
	return () => {
		if (initialTimer !== null) clearTimeout(initialTimer);
		handlerSet.delete(registeredHandler);
		if (handlerSet.size === 0) browserEventHandlers.delete(event);
	};
}


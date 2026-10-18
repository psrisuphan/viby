import { mockPlaybackState, mockQueue } from "./mocks";

export type UnlistenFn = () => void;

type BrowserEventHandler = (payload: unknown) => void;
const browserEventHandlers = new Map<string, Set<BrowserEventHandler>>();

export function emitBrowserTestEvent<T>(event: string, payload: T): void {
	for (const handler of browserEventHandlers.get(event) ?? []) {
		handler(payload);
	}
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

	setTimeout(() => {
		if (event === "playback-state") {
			emitBrowserTestEvent(event, mockPlaybackState as unknown as T);
		} else if (event === "queue-changed") {
			emitBrowserTestEvent(event, mockQueue as unknown as T);
		} else if (event === "queue-position-changed") {
			emitBrowserTestEvent(event, { current_index: 0 } as unknown as T);
		}
	}, 50);
	return () => {
		handlerSet.delete(registeredHandler);
		if (handlerSet.size === 0) browserEventHandlers.delete(event);
	};
}


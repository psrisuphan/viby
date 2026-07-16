import { mockPlaybackState, mockQueue } from "./mocks";

export type UnlistenFn = () => void;

export async function listen<T>(
	event: string,
	handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
	setTimeout(() => {
		if (event === "playback-state") {
			handler({ payload: mockPlaybackState as unknown as T });
		} else if (event === "queue-changed") {
			handler({ payload: mockQueue as unknown as T });
		} else if (event === "queue-position-changed") {
			handler({ payload: { current_index: 0 } as unknown as T });
		}
	}, 50);
	return () => {};
}


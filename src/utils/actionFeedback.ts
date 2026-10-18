import { useToastStore } from "../stores/toastStore";
import { formatInvokeError } from "./errorMessage";

const ACTION_FAILURE_DURATION_MS = 7000;

export function notifyActionFailure(
	error: unknown,
	fallback = "That action couldn't be completed.",
): string {
	const detail = formatInvokeError(error, "");
	const message = detail && detail !== fallback ? `${fallback} ${detail}` : fallback;
	useToastStore
		.getState()
		.addToast(message, "error", ACTION_FAILURE_DURATION_MS);
	return message;
}

export interface UserActionFeedback<T> {
	failureMessage: string;
	successMessage?: string | ((result: T) => string);
}

/** Run an event-driven action without leaking a rejected promise to the UI. */
export async function runActionWithFeedback<T>(
	action: () => T | Promise<T>,
	feedback: UserActionFeedback<T>,
): Promise<T | undefined> {
	try {
		const result = await action();
		const successMessage = feedback.successMessage;
		if (successMessage) {
			const message =
				typeof successMessage === "function"
					? successMessage(result)
					: successMessage;
			if (message) useToastStore.getState().addToast(message, "success");
		}
		return result;
	} catch (error) {
		notifyActionFailure(error, feedback.failureMessage);
		return undefined;
	}
}

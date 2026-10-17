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

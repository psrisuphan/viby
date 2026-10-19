import { useEffect } from "react";
import { notifyActionFailure } from "../utils/actionFeedback";

export function useUnhandledActionRejection() {
	useEffect(() => {
		const handleUnhandledActionRejection = (event: PromiseRejectionEvent) => {
			console.error("Unhandled promise rejection:", event.reason);
			notifyActionFailure(event.reason, "An unexpected error occurred.");
		};

		window.addEventListener("unhandledrejection", handleUnhandledActionRejection);
		return () =>
			window.removeEventListener("unhandledrejection", handleUnhandledActionRejection);
	}, []);
}

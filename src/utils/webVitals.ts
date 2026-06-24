import { onCLS, onINP, onLCP } from "web-vitals/attribution";

export function startWebVitalsLogging() {
	const log = (metric: unknown) => console.info("[VibyWebVitals]", metric);
	onCLS(log);
	onINP(log);
	onLCP(log);
}

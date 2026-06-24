import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function bootstrap() {
	if (
		import.meta.env.DEV &&
		localStorage.getItem("vibyWhyDidYouRender") === "1"
	) {
		await import("./wdyr");
	}
	if (import.meta.env.DEV && localStorage.getItem("vibyWebVitals") === "1") {
		const { startWebVitalsLogging } = await import("./utils/webVitals");
		startWebVitalsLogging();
	}

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
}

void bootstrap();

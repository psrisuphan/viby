import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const MiniApp = lazy(() => import("./components/player/MiniApp"));
const TheaterApp = lazy(() => import("./components/player/TheaterApp"));
import { initializeTheme } from "./stores/themeStore";
import { getCurrentWindow } from "@tauri-apps/api/window";

initializeTheme();

const windowLabel =
	"__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "main";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<Suspense fallback={null}>
			{windowLabel === "mini" ? (
				<MiniApp />
			) : windowLabel === "theater" ? (
				<TheaterApp />
			) : (
				<App />
			)}
		</Suspense>
	</React.StrictMode>,
);

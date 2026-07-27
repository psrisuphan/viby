import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MiniApp from "./components/player/MiniApp";
import { initializeTheme } from "./stores/themeStore";
import { getCurrentWindow } from "@tauri-apps/api/window";

initializeTheme();

const isMiniWindow =
	"__TAURI_INTERNALS__" in window && getCurrentWindow().label === "mini";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		{isMiniWindow ? <MiniApp /> : <App />}
	</React.StrictMode>,
);

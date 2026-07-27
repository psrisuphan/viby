import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MiniApp from "./components/player/MiniApp";
import TheaterApp from "./components/player/TheaterApp";
import { initializeTheme } from "./stores/themeStore";
import { getCurrentWindow } from "@tauri-apps/api/window";

initializeTheme();

const windowLabel =
	"__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "main";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		{windowLabel === "mini" ? (
			<MiniApp />
		) : windowLabel === "theater" ? (
			<TheaterApp />
		) : (
			<App />
		)}
	</React.StrictMode>,
);

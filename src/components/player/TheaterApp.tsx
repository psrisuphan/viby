import { useState, useCallback } from "react";
import { usePlayerSync } from "../../hooks/usePlayerSync";
import { leaveTheaterMode } from "../../utils/tauri";
import FullscreenPlayer from "./FullscreenPlayer";
import ToastContainer from "../ui/ToastContainer";

export default function TheaterApp() {
	usePlayerSync();
	const [isExiting, setIsExiting] = useState(false);

	const handleExit = useCallback(() => {
		setIsExiting(true);
		setTimeout(() => {
			void leaveTheaterMode().then(() => {
				setIsExiting(false);
			});
		}, 160);
	}, []);

	return (
		<div
			className={`app-container theater-mode ${
				isExiting ? "theater-window-exit" : "theater-window-enter"
			}`}
		>
			<FullscreenPlayer onExit={handleExit} />
			<ToastContainer />
		</div>
	);
}

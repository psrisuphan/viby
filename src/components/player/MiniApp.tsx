import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useUiStore } from "../../stores/uiStore";
import { usePlayerSync } from "../../hooks/usePlayerSync";
import { leaveMiniPlayer } from "../../utils/tauri";
import MiniPlayer from "./MiniPlayer";
import ToastContainer from "../ui/ToastContainer";

const MINI_SIZE = new LogicalSize(420, 200);
const MINI_QUEUE_SIZE = new LogicalSize(420, 500);

export default function MiniApp() {
	usePlayerSync();
	const isQueueOpen = useUiStore((s) => s.isQueueOpen);
	const [isExiting, setIsExiting] = useState(false);

	useEffect(() => {
		const targetSize = isQueueOpen ? MINI_QUEUE_SIZE : MINI_SIZE;
		void getCurrentWindow()
			.setSize(targetSize)
			.catch((err) => console.error("Failed to resize mini window:", err));
	}, [isQueueOpen]);

	const handleExpand = useCallback(() => {
		setIsExiting(true);
		setTimeout(() => {
			void leaveMiniPlayer().then(() => {
				setIsExiting(false);
			});
		}, 160);
	}, []);

	return (
		<div
			className={`app-container mini-player-mode ${
				isExiting ? "mini-window-exit" : "mini-window-enter"
			}`}
		>
			<MiniPlayer onExpand={handleExpand} />
			<ToastContainer />
		</div>
	);
}

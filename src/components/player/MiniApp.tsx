import { useEffect } from "react";
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

	useEffect(() => {
		const targetSize = isQueueOpen ? MINI_QUEUE_SIZE : MINI_SIZE;
		void getCurrentWindow()
			.setSize(targetSize)
			.catch((err) => console.error("Failed to resize mini window:", err));
	}, [isQueueOpen]);

	return (
		<div className="app-container mini-player-mode">
			<MiniPlayer onExpand={() => void leaveMiniPlayer()} />
			<ToastContainer />
		</div>
	);
}

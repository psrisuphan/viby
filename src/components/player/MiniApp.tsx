import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useUiStore } from "../../stores/uiStore";
import { usePlayerSync } from "../../hooks/usePlayerSync";
import { leaveMiniPlayer } from "../../utils/tauri";
import { runActionWithFeedback } from "../../utils/actionFeedback";
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
		void runActionWithFeedback(
			() => getCurrentWindow().setSize(targetSize),
			{ failureMessage: "Couldn't resize the mini player." },
		);
	}, [isQueueOpen]);

	const handleExpand = useCallback(() => {
		setIsExiting(true);
		setTimeout(() => {
			void runActionWithFeedback(() => leaveMiniPlayer(), {
				failureMessage: "Couldn't return from the mini player.",
			}).finally(() => {
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

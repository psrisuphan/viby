import { useState, useCallback } from "react";
import { usePlayerSync } from "../../hooks/usePlayerSync";
import { useUnhandledActionRejection } from "../../hooks/useUnhandledActionRejection";
import { leaveTheaterMode } from "../../utils/tauri";
import { runWindowModeExit } from "../../utils/actionFeedback";
import FullscreenPlayer from "./FullscreenPlayer";
import ToastContainer from "../ui/ToastContainer";

export default function TheaterApp() {
  usePlayerSync();
  useUnhandledActionRejection();
  const [isExiting, setIsExiting] = useState(false);

  const handleExit = useCallback(() => {
    void runWindowModeExit(
      setIsExiting,
      () => leaveTheaterMode(),
      "Couldn't leave theater mode.",
    );
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

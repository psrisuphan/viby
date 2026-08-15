import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { clearArtworkCache } from "../utils/useArtwork";
import { setFrontendVisible as setFrontendVisibleBackend } from "../utils/tauri";

export function useFrontendVisibility() {
	const [frontendVisible, setFrontendVisible] = useState(() => !document.hidden);
	const frontendVisibleRef = useRef(frontendVisible);

	const markFrontendVisible = useCallback((visible: boolean) => {
		frontendVisibleRef.current = visible;
		setFrontendVisible(visible);
	}, []);

	useEffect(() => {
		let unlistenVisibility: (() => void) | undefined;
		let cancelled = false;
		const setVisibility = (visible: boolean) => {
			if (frontendVisibleRef.current === visible) return;
			frontendVisibleRef.current = visible;
			setFrontendVisible(visible);
			if (!visible) clearArtworkCache();
		};
		const syncVisibility = () => {
			const visible = !document.hidden;
			setVisibility(visible);
			setFrontendVisibleBackend(visible).catch((err) =>
				console.error("Failed to sync frontend visibility:", err),
			);
		};
		const updateWindowActivity = () => {
			document.documentElement.classList.toggle(
				"app-window-inactive",
				!document.hasFocus(),
			);
		};

		listen<boolean>("frontend-visibility-changed", (event) =>
			setVisibility(event.payload),
		)
			.then((unlisten) => {
				if (cancelled) unlisten();
				else unlistenVisibility = unlisten;
			})
			.catch((err) => console.error("Failed to listen for window visibility:", err));
		window.addEventListener("focus", updateWindowActivity);
		window.addEventListener("blur", updateWindowActivity);
		document.addEventListener("visibilitychange", updateWindowActivity);
		document.addEventListener("visibilitychange", syncVisibility);
		updateWindowActivity();
		syncVisibility();

		return () => {
			cancelled = true;
			unlistenVisibility?.();
			window.removeEventListener("focus", updateWindowActivity);
			window.removeEventListener("blur", updateWindowActivity);
			document.removeEventListener("visibilitychange", updateWindowActivity);
			document.removeEventListener("visibilitychange", syncVisibility);
		};
	}, []);

	return { frontendVisible, markFrontendVisible };
}

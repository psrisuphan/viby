import { useEffect, useState } from "react";

export function useWindowActive() {
	const [active, setActive] = useState(
		() => !document.hidden && document.hasFocus(),
	);

	useEffect(() => {
		const update = () => setActive(!document.hidden && document.hasFocus());
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		document.addEventListener("visibilitychange", update);
		return () => {
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
			document.removeEventListener("visibilitychange", update);
		};
	}, []);

	return active;
}

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion() {
	const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);

	useEffect(() => {
		const media = window.matchMedia(QUERY);
		const update = () => setReduced(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	return reduced;
}

import {
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type HTMLAttributes,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import CustomScrollbar from "./CustomScrollbar";

export type ScrollAreaOrientation = "vertical" | "horizontal";

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
	orientation?: ScrollAreaOrientation;
	viewportClassName?: string;
	viewportProps?: HTMLAttributes<HTMLDivElement>;
	controls?: boolean;
}

/**
 * Unified app scrollbar primitive.
 *
 * Use ScrollArea for every new scrollable region instead of native scrollbars
 * or one-off CSS. It hides the browser scrollbar and overlays CustomScrollbar
 * for vertical and horizontal scrolling.
 */
export default function ScrollArea({
	children,
	orientation = "vertical",
	className = "",
	viewportClassName = "",
	viewportProps,
	controls = false,
	...hostProps
}: ScrollAreaProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const [canScrollBack, setCanScrollBack] = useState(false);
	const [canScrollForward, setCanScrollForward] = useState(false);
	const overflowClass =
		orientation === "vertical"
			? "scroll-area__viewport--vertical"
			: "scroll-area__viewport--horizontal";

	const updateControls = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		setCanScrollBack(viewport.scrollLeft > 1);
		setCanScrollForward(
			viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1,
		);
	}, []);

	useLayoutEffect(() => {
		if (!controls) return;
		const viewport = viewportRef.current;
		if (!viewport) return;
		const observer = new ResizeObserver(updateControls);
		observer.observe(viewport);
		for (const child of viewport.children) observer.observe(child);
		viewport.addEventListener("scroll", updateControls, { passive: true });
		updateControls();
		return () => {
			observer.disconnect();
			viewport.removeEventListener("scroll", updateControls);
		};
	}, [controls, updateControls]);

	const scroll = (direction: -1 | 1) => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const reducedMotion =
			document.documentElement.classList.contains("reduce-visual-effects") ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		viewport.scrollBy({
			left: direction * viewport.clientWidth * 0.75,
			behavior: reducedMotion ? "auto" : "smooth",
		});
	};

	return (
		<div
			className={`scrollbar-host scroll-area ${controls ? "scroll-area--controlled" : ""} ${className}`}
			{...hostProps}
		>
			<div
				{...viewportProps}
				ref={viewportRef}
				className={`scroll-area__viewport ${overflowClass} ${viewportClassName} ${viewportProps?.className ?? ""}`}
			>
				{children}
			</div>
			{controls ? (
				<div className="scroll-area__controls">
					<button
						className="scroll-area__control"
						onClick={() => scroll(-1)}
						disabled={!canScrollBack}
						aria-label="Scroll left"
					>
						<ChevronLeft size={20} />
					</button>
					<button
						className="scroll-area__control"
						onClick={() => scroll(1)}
						disabled={!canScrollForward}
						aria-label="Scroll right"
					>
						<ChevronRight size={20} />
					</button>
				</div>
			) : (
				<CustomScrollbar scrollRef={viewportRef} orientation={orientation} />
			)}
		</div>
	);
}

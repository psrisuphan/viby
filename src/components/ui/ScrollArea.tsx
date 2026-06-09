import { useRef, type ReactNode, type HTMLAttributes } from "react";
import CustomScrollbar from "./CustomScrollbar";

export type ScrollAreaOrientation = "vertical" | "horizontal";

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
	orientation?: ScrollAreaOrientation;
	viewportClassName?: string;
	viewportProps?: HTMLAttributes<HTMLDivElement>;
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
	...hostProps
}: ScrollAreaProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const overflowClass =
		orientation === "vertical"
			? "scroll-area__viewport--vertical"
			: "scroll-area__viewport--horizontal";

	return (
		<div className={`scrollbar-host scroll-area ${className}`} {...hostProps}>
			<div
				{...viewportProps}
				ref={viewportRef}
				className={`scroll-area__viewport ${overflowClass} ${viewportClassName} ${viewportProps?.className ?? ""}`}
			>
				{children}
			</div>
			<CustomScrollbar scrollRef={viewportRef} orientation={orientation} />
		</div>
	);
}

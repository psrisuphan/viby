export type FixedCornerResizeDirection = "South" | "East" | "SouthEast";

export function resizeFromFixedTopLeft(
	direction: FixedCornerResizeDirection,
	startWidth: number,
	startHeight: number,
	deltaX: number,
	deltaY: number,
	minWidth: number,
	minHeight: number,
) {
	return {
		width: Math.max(minWidth, startWidth + (direction === "South" ? 0 : deltaX)),
		height: Math.max(minHeight, startHeight + (direction === "East" ? 0 : deltaY)),
	};
}

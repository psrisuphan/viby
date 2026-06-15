import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getPlatform } from "../../utils/platform";
import "./CustomScrollbar.css";

type ScrollbarOrientation = "vertical" | "horizontal";

interface CustomScrollbarProps {
	scrollRef: RefObject<HTMLElement | null>;
	orientation?: ScrollbarOrientation;
	className?: string;
}

interface ThumbState {
	start: number;
	size: number;
}

const isLinux = getPlatform() === "linux";

export default function CustomScrollbar({
	scrollRef,
	orientation = "vertical",
	className = "",
}: CustomScrollbarProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	const dragCleanupRef = useRef<(() => void) | null>(null);
	const rafRef = useRef<number | null>(null);
	const [thumb, setThumb] = useState<ThumbState | null>(null);
	const [dragging, setDragging] = useState(false);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const update = () => {
			rafRef.current = null;
			const scrollOffset =
				orientation === "vertical" ? el.scrollTop : el.scrollLeft;
			const scrollSize =
				orientation === "vertical" ? el.scrollHeight : el.scrollWidth;
			const clientSize =
				orientation === "vertical" ? el.clientHeight : el.clientWidth;

			if (scrollSize <= clientSize + 1) {
				setThumb(null);
				return;
			}

			const size = Math.max((clientSize / scrollSize) * clientSize, 36);
			const start =
				(scrollOffset / (scrollSize - clientSize)) * (clientSize - size);
			setThumb({ start, size });
		};

		const scheduleUpdate = () => {
			if (rafRef.current !== null) return;
			rafRef.current = requestAnimationFrame(update);
		};

		el.addEventListener("scroll", scheduleUpdate, { passive: true });

		const resizeObserver = new ResizeObserver(scheduleUpdate);
		resizeObserver.observe(el);
		for (const child of Array.from(el.children)) {
			resizeObserver.observe(child);
		}

		const mutationObserver = new MutationObserver(() => {
			for (const child of Array.from(el.children)) {
				resizeObserver.observe(child);
			}
			scheduleUpdate();
		});
		mutationObserver.observe(el, {
			attributes: true,
			childList: true,
			characterData: true,
			subtree: true,
		});

		scheduleUpdate();
		const initialFrames = [1, 2, 3].map((frame) =>
			requestAnimationFrame(() => {
				if (frame === 3) update();
				scheduleUpdate();
			}),
		);

		return () => {
			el.removeEventListener("scroll", scheduleUpdate);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			for (const id of initialFrames) cancelAnimationFrame(id);
			dragCleanupRef.current?.();
		};
	}, [scrollRef, orientation]);

	const handleThumbPointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		if (isLinux && event.pointerType !== "mouse") return;
		const scrollEl = scrollRef.current;
		const trackEl = trackRef.current;
		if (!scrollEl || !trackEl || !thumb) return;

		event.preventDefault();
		event.stopPropagation();

		const thumbEl = event.currentTarget;
		const pointerId = event.pointerId;
		thumbEl.setPointerCapture(pointerId);
		setDragging(true);

		const startPointer =
			orientation === "vertical" ? event.clientY : event.clientX;
		const startScrollOffset =
			orientation === "vertical" ? scrollEl.scrollTop : scrollEl.scrollLeft;
		const scrollSize =
			orientation === "vertical" ? scrollEl.scrollHeight : scrollEl.scrollWidth;
		const clientSize =
			orientation === "vertical" ? scrollEl.clientHeight : scrollEl.clientWidth;
		const trackSize =
			orientation === "vertical" ? trackEl.clientHeight : trackEl.clientWidth;
		const maxScrollOffset = scrollSize - clientSize;
		const maxThumbStart = Math.max(trackSize - thumb.size, 1);

		const onMove = (moveEvent: PointerEvent) => {
			const pointer =
				orientation === "vertical" ? moveEvent.clientY : moveEvent.clientX;
			const delta = pointer - startPointer;
			const nextOffset = Math.max(
				0,
				Math.min(
					startScrollOffset + (delta / maxThumbStart) * maxScrollOffset,
					maxScrollOffset,
				),
			);

			if (orientation === "vertical") {
				scrollEl.scrollTop = nextOffset;
			} else {
				scrollEl.scrollLeft = nextOffset;
			}
		};

		const cleanup = () => {
			thumbEl.removeEventListener("pointermove", onMove);
			thumbEl.removeEventListener("pointerup", cleanup);
			thumbEl.removeEventListener("pointercancel", cleanup);
			thumbEl.removeEventListener("lostpointercapture", cleanup);
			window.removeEventListener("blur", cleanup);
			if (thumbEl.hasPointerCapture(pointerId)) {
				thumbEl.releasePointerCapture(pointerId);
			}
			setDragging(false);
			dragCleanupRef.current = null;
		};

		dragCleanupRef.current = cleanup;
		thumbEl.addEventListener("pointermove", onMove);
		thumbEl.addEventListener("pointerup", cleanup);
		thumbEl.addEventListener("pointercancel", cleanup);
		thumbEl.addEventListener("lostpointercapture", cleanup);
		window.addEventListener("blur", cleanup);
	};

	const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (isLinux && event.pointerType !== "mouse") return;
		const trackEl = trackRef.current;
		const scrollEl = scrollRef.current;
		if (!trackEl || !scrollEl || !thumb || event.target !== trackEl) return;
		event.preventDefault();

		const rect = trackEl.getBoundingClientRect();
		const clickStart =
			orientation === "vertical"
				? event.clientY - rect.top
				: event.clientX - rect.left;
		const trackSize =
			orientation === "vertical" ? trackEl.clientHeight : trackEl.clientWidth;
		const clientSize =
			orientation === "vertical" ? scrollEl.clientHeight : scrollEl.clientWidth;
		const scrollSize =
			orientation === "vertical" ? scrollEl.scrollHeight : scrollEl.scrollWidth;
		const thumbStart = clickStart - thumb.size / 2;
		const maxThumbStart = Math.max(trackSize - thumb.size, 1);
		const ratio = Math.max(0, Math.min(thumbStart / maxThumbStart, 1));
		const nextOffset = ratio * (scrollSize - clientSize);

		if (orientation === "vertical") {
			scrollEl.scrollTop = nextOffset;
		} else {
			scrollEl.scrollLeft = nextOffset;
		}
	};

	return (
		<div
			className={`app-scrollbar-track app-scrollbar-track--${orientation} ${thumb ? "is-ready" : "is-hidden"} ${dragging ? "is-dragging" : ""} ${className}`}
			ref={trackRef}
			onPointerDown={handleTrackPointerDown}
			aria-hidden="true"
		>
			{thumb && (
				<div
					className="app-scrollbar-thumb"
					style={
						orientation === "vertical"
							? {
									transform: `translate3d(0, ${thumb.start}px, 0)`,
									height: thumb.size,
								}
							: {
									transform: `translate3d(${thumb.start}px, 0, 0)`,
									width: thumb.size,
								}
					}
					onPointerDown={handleThumbPointerDown}
				/>
			)}
		</div>
	);
}

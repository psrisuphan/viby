import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import "./CustomScrollbar.css";

interface CustomScrollbarProps {
	scrollRef: RefObject<HTMLElement | null>;
	className?: string;
}

export default function CustomScrollbar({
	scrollRef,
	className = "",
}: CustomScrollbarProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	const dragCleanupRef = useRef<(() => void) | null>(null);
	const [thumb, setThumb] = useState<{ top: number; height: number } | null>(
		null,
	);
	const [dragging, setDragging] = useState(false);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const update = () => {
			const { scrollTop, scrollHeight, clientHeight } = el;
			if (scrollHeight <= clientHeight + 1) {
				setThumb(null);
				return;
			}

			const height = Math.max((clientHeight / scrollHeight) * clientHeight, 36);
			const top =
				(scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
			setThumb({ top, height });
		};

		el.addEventListener("scroll", update, { passive: true });
		const resizeObserver = new ResizeObserver(update);
		resizeObserver.observe(el);

		const mutationObserver = new MutationObserver(update);
		mutationObserver.observe(el, { childList: true, subtree: true });

		update();
		requestAnimationFrame(update);

		return () => {
			el.removeEventListener("scroll", update);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			dragCleanupRef.current?.();
		};
	}, [scrollRef]);

	const handleThumbPointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		const scrollEl = scrollRef.current;
		const trackEl = trackRef.current;
		if (!scrollEl || !trackEl || !thumb) return;

		event.preventDefault();
		event.stopPropagation();

		const thumbEl = event.currentTarget;
		const pointerId = event.pointerId;
		thumbEl.setPointerCapture(pointerId);
		setDragging(true);

		const startY = event.clientY;
		const startScrollTop = scrollEl.scrollTop;
		const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
		const maxThumbTop = Math.max(trackEl.clientHeight - thumb.height, 1);

		const onMove = (moveEvent: PointerEvent) => {
			const deltaY = moveEvent.clientY - startY;
			scrollEl.scrollTop = Math.max(
				0,
				Math.min(
					startScrollTop + (deltaY / maxThumbTop) * maxScrollTop,
					maxScrollTop,
				),
			);
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

	const handleTrackClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const trackEl = trackRef.current;
		const scrollEl = scrollRef.current;
		if (!trackEl || !scrollEl || !thumb || event.target !== trackEl) return;

		const rect = trackEl.getBoundingClientRect();
		const thumbTop = event.clientY - rect.top - thumb.height / 2;
		const maxThumbTop = Math.max(trackEl.clientHeight - thumb.height, 1);
		const ratio = Math.max(0, Math.min(thumbTop / maxThumbTop, 1));
		scrollEl.scrollTop =
			ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
	};

	if (!thumb) return null;

	return (
		<div
			className={`app-scrollbar-track ${dragging ? "is-dragging" : ""} ${className}`}
			ref={trackRef}
			onClick={handleTrackClick}
			aria-hidden="true"
		>
			<div
				className="app-scrollbar-thumb"
				style={{ top: thumb.top, height: thumb.height }}
				onPointerDown={handleThumbPointerDown}
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

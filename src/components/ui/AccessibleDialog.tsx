import {
	useEffect,
	useRef,
	type CSSProperties,
	type MouseEvent,
	type ReactNode,
} from "react";
import { FOCUSABLE_SELECTOR, getWrappedTabTarget } from "./dialogFocus";

const openDialogStack: HTMLDivElement[] = [];

interface AccessibleDialogProps {
	ariaLabel: string;
	ariaLabelledBy?: string;
	ariaDescribedBy?: string;
	children: ReactNode;
	overlayClassName: string;
	contentClassName: string;
	contentRef?: (element: HTMLDivElement | null) => void;
	overlayStyle?: CSSProperties;
	contentStyle?: CSSProperties;
	overlayContent?: ReactNode;
	noDrag?: boolean;
	modal?: boolean;
	trapFocus?: boolean;
	closeOnEscape?: boolean;
	closeOnBackdrop?: boolean;
	onClose: () => void;
}

export default function AccessibleDialog({
	ariaLabel,
	ariaLabelledBy,
	ariaDescribedBy,
	children,
	overlayClassName,
	contentClassName,
	contentRef,
	overlayStyle,
	contentStyle,
	overlayContent,
	noDrag = false,
	modal = true,
	trapFocus = modal,
	closeOnEscape = true,
	closeOnBackdrop = true,
	onClose,
}: AccessibleDialogProps) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		const previousFocus = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		openDialogStack.push(dialog);

		const getFocusable = () => Array.from(
			dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		).filter((element) =>
			!element.closest('[hidden], [aria-hidden="true"]') &&
			getComputedStyle(element).visibility !== "hidden" &&
			getComputedStyle(element).display !== "none" &&
			element.getClientRects().length > 0,
		);

		const focusInitial = () => {
			const focusable = getFocusable();
			const requested = dialog.querySelector<HTMLElement>(
				'[autofocus], [data-dialog-initial-focus]',
			);
			(requested && getComputedStyle(requested).display !== "none"
				? requested
				: focusable[0] ?? dialog).focus({ preventScroll: true });
		};

		if (!dialog.contains(document.activeElement)) focusInitial();

		const isTopDialog = () => openDialogStack[openDialogStack.length - 1] === dialog;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isTopDialog()) return;
			if (event.key === "Escape" && closeOnEscape) {
				event.preventDefault();
				event.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (!trapFocus || event.key !== "Tab") return;
			const focusable = getFocusable();
			const target = getWrappedTabTarget(
				focusable,
				document.activeElement instanceof HTMLElement ? document.activeElement : null,
				event.shiftKey,
			);
			if (target) {
				event.preventDefault();
				target.focus();
			} else if (focusable.length === 0) {
				event.preventDefault();
				dialog.focus();
			}
		};

		const handleFocusIn = (event: FocusEvent) => {
			if (isTopDialog() && modal && trapFocus && !dialog.contains(event.target as Node)) {
				focusInitial();
			}
		};

		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("focusin", handleFocusIn, true);
		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
			document.removeEventListener("focusin", handleFocusIn, true);
			const stackIndex = openDialogStack.lastIndexOf(dialog);
			if (stackIndex >= 0) openDialogStack.splice(stackIndex, 1);
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, [closeOnEscape, modal, trapFocus]);

	const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
		if (closeOnBackdrop && event.target === event.currentTarget) {
			onCloseRef.current();
		}
	};

	return (
		<div
			className={overlayClassName}
			style={overlayStyle}
			data-tauri-no-drag={noDrag || undefined}
			onClick={handleBackdropClick}
		>
			{overlayContent}
			<div
				ref={(element) => {
					dialogRef.current = element;
					contentRef?.(element);
				}}
				className={contentClassName}
				style={contentStyle}
				role="dialog"
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				aria-modal={modal}
				tabIndex={-1}
				onClick={(event) => event.stopPropagation()}
			>
				{children}
			</div>
		</div>
	);
}

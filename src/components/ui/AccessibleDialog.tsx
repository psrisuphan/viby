import {
	createContext,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	type CSSProperties,
	type MutableRefObject,
	type RefObject,
	type MouseEvent,
	type ReactNode,
} from "react";
import { FOCUSABLE_SELECTOR, getWrappedTabTarget, isFocusEligible } from "./dialogFocus";
import { isTopDialog, registerDialog } from "./dialogManager";

interface DialogScope {
	depth: number;
	elementRef: RefObject<HTMLDivElement | null>;
	lastFocusedRef: MutableRefObject<HTMLElement | null>;
}

const DialogContext = createContext<DialogScope | null>(null);

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
	const parentDialog = useContext(DialogContext);
	const dialogRef = useRef<HTMLDivElement>(null);
	const lastFocusedRef = useRef<HTMLElement | null>(null);
	const initialFocusRef = useRef<HTMLElement | null>(
		typeof document !== "undefined" && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null,
	);
	const onCloseRef = useRef(onClose);
	const closeOnEscapeRef = useRef(closeOnEscape);
	const modalRef = useRef(modal);
	const trapFocusRef = useRef(trapFocus);
	onCloseRef.current = onClose;
	closeOnEscapeRef.current = closeOnEscape;
	modalRef.current = modal;
	trapFocusRef.current = trapFocus;
	const depth = (parentDialog?.depth ?? -1) + 1;

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		const isTabReachable = (element: HTMLElement) =>
			element.tabIndex >= 0 && isFocusEligible(element);

		const getFocusable = () => Array.from(
			dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		).filter(isTabReachable);

		// React's autoFocus prop is applied by calling focus() during commit, not by writing the
		// attribute, so a child that already holds focus inside the dialog counts as requested.
		const focusInitial = () => {
			const active = document.activeElement;
			const requested = Array.from(
				dialog.querySelectorAll<HTMLElement>('[autofocus], [data-dialog-initial-focus]'),
			);
			const candidates = [
				...requested,
				...(active instanceof HTMLElement && active !== dialog && dialog.contains(active) ? [active] : []),
				...getFocusable(),
			];
			for (const candidate of candidates) {
				if (!isTabReachable(candidate)) continue;
				candidate.focus({ preventScroll: true });
				if (document.activeElement === candidate) return;
			}
			dialog.focus({ preventScroll: true });
		};

		const unregister = registerDialog({
			element: dialog,
			depth,
			modal,
			previousFocus: initialFocusRef.current,
			parentElement: () => parentDialog?.elementRef.current ?? null,
			parentLastFocused: parentDialog?.lastFocusedRef ?? { current: null },
		});
		if (isTopDialog(dialog)) focusInitial();

		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isTopDialog(dialog)) return;
			if (event.key === "Escape" && closeOnEscapeRef.current) {
				event.preventDefault();
				event.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (!trapFocusRef.current || event.key !== "Tab") return;
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
			const target = event.target;
			if (target instanceof HTMLElement && dialog.contains(target)) {
				lastFocusedRef.current = target;
			}
			if (
				isTopDialog(dialog) &&
				modalRef.current &&
				trapFocusRef.current &&
				!dialog.contains(target as Node)
			) {
				focusInitial();
			}
		};

		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("focusin", handleFocusIn, true);
		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
			document.removeEventListener("focusin", handleFocusIn, true);
			unregister();
		};
	}, [depth, modal, parentDialog]);

	const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
		if (closeOnBackdrop && event.target === event.currentTarget) {
			onCloseRef.current();
		}
	};

	const scope = useMemo<DialogScope>(() => ({
		depth,
		elementRef: dialogRef,
		lastFocusedRef,
	}), [depth]);

	return (
		<DialogContext.Provider value={scope}>
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
		</DialogContext.Provider>
	);
}

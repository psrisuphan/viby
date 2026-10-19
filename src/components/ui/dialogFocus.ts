export const FOCUSABLE_SELECTOR = [
	'a[href]',
	'area[href]',
	'button',
	'input:not([type="hidden"])',
	'select',
	'textarea',
	'iframe',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex^="-"])',
].join(",");

// Shared by Tab cycling and requested initial focus so both agree on what a user can reach.
// Element-level checks only; callers add their own tab-order rule (tabIndex >= 0 for Tab cycling).
export function isFocusEligible(element: HTMLElement): boolean {
	if (!element.isConnected) return false;
	if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
	if (element.matches(":disabled")) return false;
	const style = getComputedStyle(element);
	return style.display !== "none" &&
		style.visibility !== "hidden" &&
		style.visibility !== "collapse" &&
		element.getClientRects().length > 0;
}

export function getDialogOwnedPortals(dialog: HTMLElement): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-dialog-owner]"),
	).filter((element) => element.dataset.dialogOwner === dialog.id);
}

export function isWithinDialogScope(dialog: HTMLElement, target: Node | null): boolean {
	if (!target) return false;
	return dialog.contains(target) ||
		getDialogOwnedPortals(dialog).some((portal) => portal.contains(target));
}

export function getWrappedTabTarget<T>(
	focusable: readonly T[],
	active: T | null,
	shiftKey: boolean,
): T | null {
	if (focusable.length === 0) return null;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (shiftKey && (active === first || !focusable.includes(active as T))) {
		return last;
	}
	if (!shiftKey && (active === last || !focusable.includes(active as T))) {
		return first;
	}
	return null;
}

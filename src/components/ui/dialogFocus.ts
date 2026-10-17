export const FOCUSABLE_SELECTOR = [
	'a[href]',
	'area[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'iframe',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(",");

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

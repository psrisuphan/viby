export type GlobalShortcutCommand =
	| { type: "toggleSearch" }
	| { type: "quit" }
	| { type: "playPause" }
	| { type: "nextTrack" }
	| { type: "previousOrRestart" }
	| { type: "seek"; direction: -1 | 1 }
	| { type: "volume"; direction: -1 | 1 };

function getTargetInfo(target: EventTarget | null) {
	if (!target || typeof target !== "object") return {};
	return target as { tagName?: string; isContentEditable?: boolean };
}

export function isEditableTarget(target: EventTarget | null): boolean {
	const element = getTargetInfo(target);
	return (
		["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName?.toUpperCase() ?? "") ||
		element.isContentEditable === true
	);
}

export function shouldFocusLibraryFilter(
	key: string,
	target: EventTarget | null,
	isComposing = false,
): boolean {
	return key === "/" && !isComposing && !isEditableTarget(target);
}

export function getSeekTarget(
	positionSecs: number,
	durationSecs: number,
	direction: -1 | 1,
): number {
	return Math.max(0, Math.min(durationSecs, positionSecs + direction * 5));
}

function isMultilineEditorTarget(target: EventTarget | null): boolean {
	const element = getTargetInfo(target);
	return element.tagName?.toUpperCase() === "TEXTAREA" || element.isContentEditable === true;
}

export function resolveGlobalShortcut(
	event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "target">,
	isMac: boolean,
): GlobalShortcutCommand | null {
	if (event.isComposing || isMultilineEditorTarget(event.target)) return null;

	const hasModifier = isMac ? event.metaKey : event.ctrlKey;
	const key = event.key.toLowerCase();

	if (hasModifier && key === "k") return { type: "toggleSearch" };
	if (hasModifier && key === "q") return { type: "quit" };
	if (isEditableTarget(event.target)) return null;
	if (event.key === " " && !hasModifier) return { type: "playPause" };
	if (!hasModifier) return null;

	if (event.shiftKey && event.key === "ArrowRight") {
		return { type: "seek", direction: 1 };
	}
	if (event.shiftKey && event.key === "ArrowLeft") {
		return { type: "seek", direction: -1 };
	}
	if (event.key === "ArrowRight") return { type: "nextTrack" };
	if (event.key === "ArrowLeft") return { type: "previousOrRestart" };
	if (event.key === "ArrowUp") return { type: "volume", direction: 1 };
	if (event.key === "ArrowDown") return { type: "volume", direction: -1 };
	return null;
}

export function getModifierLabel(userAgent: string): string {
	return /Macintosh|Mac OS X/i.test(userAgent) ? "⌘" : "Ctrl";
}

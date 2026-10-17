export interface SelectionModifiers {
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

export type SongRowKeyAction =
	| { type: "move-focus"; index: number }
	| { type: "play" }
	| { type: "select"; checked: boolean; modifiers: SelectionModifiers };

export function getSongRowKeyAction(
	key: string,
	targetIsRow: boolean,
	index: number,
	selected: boolean,
	modifiers: SelectionModifiers,
): SongRowKeyAction | null {
	if (key === "ArrowDown") return { type: "move-focus", index: index + 1 };
	if (key === "ArrowUp") return { type: "move-focus", index: index - 1 };
	if (targetIsRow && key === "Enter") return { type: "play" };
	if (targetIsRow && (key === " " || key === "Spacebar")) {
		return { type: "select", checked: !selected, modifiers };
	}
	return null;
}

export function updateSongSelection<T extends { id: string }>(
	selectedIds: ReadonlySet<string>,
	visibleTracks: readonly T[],
	trackId: string,
	checked: boolean,
	anchorTrackId: string | null,
	modifiers: SelectionModifiers,
): { selectedIds: Set<string>; anchorTrackId: string } {
	const next = new Set(selectedIds);
	const additive = modifiers.ctrlKey || modifiers.metaKey;

	if (modifiers.shiftKey && checked) {
		const currentIndex = visibleTracks.findIndex((track) => track.id === trackId);
		if (currentIndex < 0) {
			return { selectedIds: next, anchorTrackId: trackId };
		}
		const anchorIndex = visibleTracks.findIndex(
			(track) => track.id === anchorTrackId,
		);
		const start = anchorIndex < 0 ? currentIndex : Math.min(anchorIndex, currentIndex);
		const end = anchorIndex < 0 ? currentIndex : Math.max(anchorIndex, currentIndex);
		if (!additive) next.clear();
		visibleTracks.slice(start, end + 1).forEach((track) => next.add(track.id));
		return { selectedIds: next, anchorTrackId: anchorIndex < 0 ? trackId : anchorTrackId! };
	}

	if (checked) next.add(trackId);
	else next.delete(trackId);
	return { selectedIds: next, anchorTrackId: trackId };
}

export function getSelectedTracksInVisibleOrder<T extends { id: string }>(
	visibleTracks: readonly T[],
	selectedIds: ReadonlySet<string>,
): T[] {
	return visibleTracks.filter((track) => selectedIds.has(track.id));
}

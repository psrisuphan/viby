import type { Track } from "../../types";

export type TrackSortField = "title" | "artist" | "album" | "duration" | "date_added";
export type SortDirection = "asc" | "desc";
export type TrackSort = { field: TrackSortField; direction: SortDirection };

export function cycleSort(
	current: TrackSort | null,
	field: TrackSortField,
): TrackSort | null {
	if (current?.field !== field) return { field, direction: "asc" };
	return current.direction === "asc" ? { field, direction: "desc" } : null;
}

const textCollator = new Intl.Collator("en", {
	sensitivity: "base",
	numeric: true,
});

function compareText(left: string, right: string): number {
	return textCollator.compare(left, right);
}

function compareStableFields(left: Track, right: Track): number {
	return (
		compareText(left.title, right.title) ||
		compareText(left.artist, right.artist) ||
		compareText(left.album, right.album) ||
		(left.disc_number ?? 1) - (right.disc_number ?? 1) ||
		(left.track_number ?? 0) - (right.track_number ?? 0) ||
		left.duration_secs - right.duration_secs ||
		compareText(left.date_added, right.date_added) ||
		compareText(left.file_path, right.file_path) ||
		compareText(left.id, right.id)
	);
}

function compareDiscTrack(left: Track, right: Track): number {
	return (
		(left.disc_number ?? 1) - (right.disc_number ?? 1) ||
		(left.track_number ?? 0) - (right.track_number ?? 0)
	);
}

export function sortTracks(
	tracks: readonly Track[],
	field: TrackSortField,
	direction: SortDirection,
): Track[] {
	const multiplier = direction === "asc" ? 1 : -1;
	return [...tracks].sort((left, right) => {
		let primary: number;
		if (field === "title") primary = compareText(left.title, right.title);
		else if (field === "artist") primary = compareText(left.artist, right.artist);
		else if (field === "album") primary = compareText(left.album, right.album);
		else if (field === "duration") {
			primary = left.duration_secs - right.duration_secs;
		} else {
			const leftTime = Date.parse(left.date_added);
			const rightTime = Date.parse(right.date_added);
			const leftValid = Number.isFinite(leftTime);
			const rightValid = Number.isFinite(rightTime);
			if (leftValid !== rightValid) return leftValid ? -1 : 1;
			primary = leftValid
				? leftTime - rightTime
				: compareText(left.date_added, right.date_added);
		}

		if (primary !== 0) return primary * multiplier;
		if (field === "artist" || field === "album") {
			const discTrack = compareDiscTrack(left, right);
			if (discTrack !== 0) return discTrack;
		}
		return compareStableFields(left, right);
	});
}

export function orderTracks(
	tracks: readonly Track[],
	sort: { field: TrackSortField; direction: SortDirection } | null,
): Track[] {
	return sort ? sortTracks(tracks, sort.field, sort.direction) : [...tracks];
}

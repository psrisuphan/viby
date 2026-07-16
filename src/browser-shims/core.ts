import type { Playlist, SearchResults, TopArtist } from "../types";

type InvokeArgs = Record<string, unknown> | undefined;

import {
	mockTracks,
	mockAlbums,
	mockArtists,
	mockTargetCurves,
	mockHeadphoneMeasurements,
	mockQueue,
	mockPlaybackState
} from "./mocks";

const noopResults = {
	get_all_tracks: mockTracks,
	get_albums: mockAlbums,
	get_artists: mockArtists,
	get_playlists: [] as Playlist[],
	get_genres: ["Synthwave", "Acoustic", "Electronic", "Lofi", "Ambient"],
	get_recently_played: mockTracks.slice(0, 3),
	get_recently_added_tracks: mockTracks,
	get_top_artists_played: [
		{ name: "Neon Horizons", play_count: 12, artwork_track_id: "track-1", artwork_album: "Midnight Boulevard", artwork_album_artist: "Neon Horizons" }
	] as TopArtist[],
	get_target_curves: mockTargetCurves,
	get_headphone_measurements: mockHeadphoneMeasurements,
	get_queue: mockQueue,
	get_playback_state: mockPlaybackState,
	get_background_app_status: {
		enabled: false,
		supported: false,
		provider: "unsupported" as const,
		permission: "not-required" as const,
	},
	get_gpu_acceleration: true,
	is_kde_desktop: false,
	search: { tracks: mockTracks, albums: mockAlbums, artists: mockArtists } as SearchResults,
	get_track_artwork: null,
	run_autoeq: { bands: [], preamp: 0, loss: 0, maxResponseDb: 0 },
	import_target_curve: { name: "", points: [] as [number, number][] },
	import_headphone_measurement: { name: "", points: [] as [number, number][] },
	create_playlist: { id: "browser-test", name: "", track_count: 0, created_at: "", updated_at: "" },
	get_album_tracks: mockTracks,
	get_playlist_tracks: mockTracks,
};

export async function invoke<T = unknown>(command: string, _args?: InvokeArgs): Promise<T> {
	if (command === "calculate_eq_response") {
		const request = _args?.request as { frequencies?: number[] } | undefined;
		return (request?.frequencies?.map(() => 0) ?? []) as T;
	}

	switch (command) {
		case "get_all_tracks":
		case "get_albums":
		case "get_artists":
		case "get_playlists":
		case "get_genres":
		case "get_recently_played":
		case "get_recently_added_tracks":
		case "get_top_artists_played":
		case "get_target_curves":
		case "get_headphone_measurements":
		case "get_queue":
		case "get_playback_state":
		case "get_background_app_status":
		case "get_gpu_acceleration":
		case "is_kde_desktop":
		case "search":
		case "get_track_artwork":
		case "run_autoeq":
		case "import_target_curve":
		case "import_headphone_measurement":
		case "create_playlist":
		case "get_album_tracks":
		case "get_playlist_tracks":
			return noopResults[command as keyof typeof noopResults] as T;
		default:
			return undefined as T;
	}
}

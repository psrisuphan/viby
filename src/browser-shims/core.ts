import type { Track, Album, Artist, Playlist, PlaybackState, SearchResults, QueuePayload, TopArtist } from "../types";

type InvokeArgs = Record<string, unknown> | undefined;

function emptyPlaybackState(): PlaybackState {
	return {
		is_playing: false,
		current_track: null,
		position_secs: 0,
		duration_secs: 0,
		volume: 1,
		shuffle: false,
		repeat_mode: "off",
	};
}

function emptySearchResults(): SearchResults {
	return { tracks: [], albums: [], artists: [] };
}

function emptyQueue(): QueuePayload {
	return { tracks: [], current_index: null };
}

const noopResults = {
	get_all_tracks: [] as Track[],
	get_albums: [] as Album[],
	get_artists: [] as Artist[],
	get_playlists: [] as Playlist[],
	get_genres: [] as string[],
	get_recently_played: [] as Track[],
	get_recently_added_tracks: [] as Track[],
	get_top_artists_played: [] as TopArtist[],
	get_target_curves: [],
	get_headphone_measurements: [],
	get_queue: emptyQueue(),
	get_playback_state: emptyPlaybackState(),
	get_background_app_status: {
		enabled: false,
		supported: false,
		provider: "unsupported" as const,
		permission: "not-required" as const,
	},
	get_gpu_acceleration: true,
	is_kde_desktop: false,
	search: emptySearchResults(),
	get_track_artwork: null,
	run_autoeq: { bands: [], preamp: 0, loss: 0, maxResponseDb: 0 },
	import_target_curve: { name: "", points: [] as [number, number][] },
	import_headphone_measurement: { name: "", points: [] as [number, number][] },
	create_playlist: { id: "browser-test", name: "", track_count: 0, created_at: "", updated_at: "" },
	get_album_tracks: [] as Track[],
	get_playlist_tracks: [] as Track[],
};

export async function invoke<T = unknown>(command: string, _args?: InvokeArgs): Promise<T> {
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

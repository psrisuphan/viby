import type { Track, Album, Artist, PlaybackState, QueuePayload } from "../types";

export const mockTracks: Track[] = [
	{
		id: "track-1",
		title: "Late Night Drive",
		artist: "Neon Horizons",
		album: "Midnight Boulevard",
		album_artist: "Neon Horizons",
		genre: "Synthwave",
		year: 2024,
		track_number: 1,
		disc_number: 1,
		duration_secs: 224,
		file_path: "/music/neon-horizons/late-night-drive.mp3",
		file_size: 8900000,
		date_added: "2026-06-01T10:00:00Z"
	},
	{
		id: "track-2",
		title: "Golden Hour",
		artist: "Acoustic Dreams",
		album: "Summer Breeze",
		album_artist: "Acoustic Dreams",
		genre: "Acoustic",
		year: 2025,
		track_number: 2,
		disc_number: 1,
		duration_secs: 185,
		file_path: "/music/acoustic-dreams/golden-hour.mp3",
		file_size: 7400000,
		date_added: "2026-06-02T11:00:00Z"
	},
	{
		id: "track-3",
		title: "Electric Pulse",
		artist: "Synth Runner",
		album: "Neon Dreams",
		album_artist: "Synth Runner",
		genre: "Electronic",
		year: 2026,
		track_number: 3,
		disc_number: 1,
		duration_secs: 260,
		file_path: "/music/synth-runner/electric-pulse.mp3",
		file_size: 10400000,
		date_added: "2026-06-03T12:00:00Z"
	},
	{
		id: "track-4",
		title: "Rainy Cafe",
		artist: "Lofi Beats Collective",
		album: "Coffee & Rain",
		album_artist: "Lofi Beats Collective",
		genre: "Lofi",
		year: 2024,
		track_number: 4,
		disc_number: 1,
		duration_secs: 145,
		file_path: "/music/lofi-beats/rainy-cafe.mp3",
		file_size: 5800000,
		date_added: "2026-06-04T13:00:00Z"
	},
	{
		id: "track-5",
		title: "Stardust",
		artist: "Cosmic Voyager",
		album: "Deep Space",
		album_artist: "Cosmic Voyager",
		genre: "Ambient",
		year: 2023,
		track_number: 5,
		disc_number: 1,
		duration_secs: 312,
		file_path: "/music/cosmic-voyager/stardust.mp3",
		file_size: 12500000,
		date_added: "2026-06-05T14:00:00Z"
	}
];

export const mockAlbums: Album[] = [
	{ name: "Midnight Boulevard", artist: "Neon Horizons", year: 2024, track_count: 1, artwork_track_id: "track-1" },
	{ name: "Summer Breeze", artist: "Acoustic Dreams", year: 2025, track_count: 1, artwork_track_id: "track-2" },
	{ name: "Neon Dreams", artist: "Synth Runner", year: 2026, track_count: 1, artwork_track_id: "track-3" },
	{ name: "Coffee & Rain", artist: "Lofi Beats Collective", year: 2024, track_count: 1, artwork_track_id: "track-4" },
	{ name: "Deep Space", artist: "Cosmic Voyager", year: 2023, track_count: 1, artwork_track_id: "track-5" }
];

export const mockArtists: Artist[] = [
	{ name: "Neon Horizons", album_count: 1, track_count: 1 },
	{ name: "Acoustic Dreams", album_count: 1, track_count: 1 },
	{ name: "Synth Runner", album_count: 1, track_count: 1 },
	{ name: "Lofi Beats Collective", album_count: 1, track_count: 1 },
	{ name: "Cosmic Voyager", album_count: 1, track_count: 1 }
];

export const mockTargetCurves = [
	{ name: "Harman OE 2018", points: [[20, 0], [100, 5], [1000, 0], [3000, 3], [10000, -2]] as [number, number][] },
	{ name: "IEF Preference 2025", points: [[20, 2], [100, 4], [1000, 0], [3000, 5], [10000, 0]] as [number, number][] },
	{ name: "Flat Target", points: [[20, 0], [20000, 0]] as [number, number][] }
];

export const mockHeadphoneMeasurements = [
	{ name: "Sennheiser HD 600", points: [[20, -5], [100, -1], [1000, 0], [3000, 2], [10000, -3]] as [number, number][] },
	{ name: "Beyerdynamic DT 990 Pro", points: [[20, -3], [100, 0], [1000, -1], [3000, 1], [10000, 6]] as [number, number][] },
	{ name: "Sony WH-1000XM4", points: [[20, 6], [100, 4], [1000, 1], [3000, -2], [10000, -4]] as [number, number][] }
];

export const mockQueue: QueuePayload = {
	tracks: mockTracks,
	current_index: 0
};

export const mockPlaybackState: PlaybackState = {
	is_playing: true,
	current_track: mockTracks[0],
	position_secs: 42,
	duration_secs: 224,
	progress_generation: 0,
	progress_sequence: 0,
	volume: 0.8,
	is_muted: false,
	previous_volume: 0.8,
	shuffle: false,
	repeat_mode: "off",
	sample_rate: 44100,
	channels: 2,
	bits_per_sample: 16,
	audio_path: {
		source_sample_rate: 44100,
		source_channels: 2,
		source_bits_per_sample: 16,
		output_sample_rate: 44100,
		output_channels: 2,
		output_sample_format: "f32",
		dsp_enabled: true,
		eq_mode: "parametric",
		app_gain: 1.0,
		resampling_active: false,
		status: "native_dsp",
		fallback_reason: null
	}
};

export function applyMockPlaybackCommand(
	command: string,
	args?: Record<string, unknown>,
): boolean {
	switch (command) {
		case "initialize_playback_preferences": {
			const legacy = args?.legacy as {
				volume?: number;
				isMuted?: boolean;
				previousVolume?: number;
				shuffle?: boolean;
				repeatMode?: string;
			} | null | undefined;
			if (legacy) {
				mockPlaybackState.volume = legacy.isMuted ? 0 : legacy.volume ?? 1;
				mockPlaybackState.is_muted = legacy.isMuted ?? false;
				mockPlaybackState.previous_volume = legacy.previousVolume ?? mockPlaybackState.volume;
				mockPlaybackState.shuffle = legacy.shuffle ?? false;
				mockPlaybackState.repeat_mode = legacy.repeatMode === "one" || legacy.repeatMode === "all"
					? legacy.repeatMode
					: "off";
			}
			return true;
		}
		case "set_volume": {
			const volume = typeof args?.volume === "number" && Number.isFinite(args.volume)
				? Math.max(0, Math.min(1, args.volume))
				: 1;
			mockPlaybackState.volume = volume;
			mockPlaybackState.is_muted = volume === 0;
			if (volume > 0) mockPlaybackState.previous_volume = volume;
			return true;
		}
		case "toggle_mute": {
			const volume = mockPlaybackState.is_muted || mockPlaybackState.volume === 0
				? mockPlaybackState.previous_volume || 1
				: 0;
			mockPlaybackState.volume = volume;
			mockPlaybackState.is_muted = volume === 0;
			if (volume > 0) mockPlaybackState.previous_volume = volume;
			return true;
		}
		case "set_shuffle":
			mockPlaybackState.shuffle = args?.enabled === true;
			return true;
		case "toggle_shuffle":
			mockPlaybackState.shuffle = !mockPlaybackState.shuffle;
			return true;
		case "set_repeat": {
			const mode = args?.mode;
			mockPlaybackState.repeat_mode = mode === "one" || mode === "all" ? mode : "off";
			return true;
		}
		case "cycle_repeat":
			mockPlaybackState.repeat_mode = mockPlaybackState.repeat_mode === "off"
				? "all"
				: mockPlaybackState.repeat_mode === "all" ? "one" : "off";
			return true;
		case "refresh_playback_metadata":
			return true;
		default:
			return false;
	}
}

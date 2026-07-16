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
	volume: 0.8,
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

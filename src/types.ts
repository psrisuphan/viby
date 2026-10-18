// Backend-owned IPC types come from the generated Rust contract.
export type {
	Album,
	AppError,
	Artist,
	ArtworkPayload,
	AudioPathStatus,
	AutoEqBand,
	AutoEqConfigKind,
	AutoEqOptions,
	AutoEqResult,
	AutoEqSmoothKind,
	AutoEqTargetCurve,
	BackgroundAppStatus,
	BoundedCurvePoints,
	EqResponseRequest,
	ImportedTextFile,
	NativeWindowTheme,
	NormalizationAnalysisStatus,
	NormalizationProgress,
	PeqBandParam,
	PlaybackState,
	Playlist,
	QueuePayload,
	QueuePositionPayload,
	RepeatMode,
	ScanIssue,
	ScanPayload,
	ScanProgress,
	ScanRootOutcome,
	ScanRootStatus,
	ScanStatus,
	SearchResults,
	TargetCurve,
	TopArtist,
	Track,
	TrackEqOverride,
} from "./bindings";

/** Library view options used by the frontend only. */
export type LibraryView = "songs" | "albums" | "artists" | "genres";

/** Sidebar navigation items used by the frontend only. */
export type SidebarSection =
	| "home"
	| "library"
	| "albums"
	| "artists"
	| "songs"
	| "genres"
	| "playlist";

/** Lightweight progress event from the playback thread. */
export interface PlaybackProgressPayload {
	position_secs: number;
	duration_secs: number;
	generation: number;
	sequence: number;
}

export function shouldRotatePlaylistArtwork(
	trackCount: number,
	windowActive: boolean,
	reduceVisualEffects: boolean,
) {
	return trackCount > 1 && windowActive && !reduceVisualEffects;
}

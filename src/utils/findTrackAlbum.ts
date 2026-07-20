import type { Album, Track } from "../types";

export function findTrackAlbum(albums: Album[], track: Track) {
	return (
		albums.find(
			(album) => album.name === track.album && album.artist === track.album_artist,
		) ??
		albums.find(
			(album) => album.name === track.album && album.artist === track.artist,
		) ??
		albums.find((album) => album.name === track.album)
	);
}

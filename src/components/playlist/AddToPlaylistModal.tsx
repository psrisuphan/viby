import { useRef, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { addToPlaylist, createPlaylist, getPlaylists } from "../../utils/tauri";
import { useToastStore } from "../../stores/toastStore";
import { ListMusic, Plus, X } from "lucide-react";
import type { Track } from "../../types";
import CustomScrollbar from "../ui/CustomScrollbar";
import "./AddToPlaylistModal.css";

interface AddToPlaylistModalProps {
	track: Track;
	onClose: () => void;
}

export default function AddToPlaylistModal({
	track,
	onClose,
}: AddToPlaylistModalProps) {
	const playlists = useLibraryStore((s) => s.playlists);
	const setPlaylists = useLibraryStore((s) => s.setPlaylists);
	const addToast = useToastStore((s) => s.addToast);
	const [isCreating, setIsCreating] = useState(false);
	const [newPlaylistName, setNewPlaylistName] = useState("");
	const playlistListRef = useRef<HTMLDivElement>(null);

	const handleAddToPlaylist = async (
		playlistId: string,
		playlistName: string,
	) => {
		try {
			await addToPlaylist(playlistId, [track.id]);
			addToast(`Added to ${playlistName}`, "success");
			onClose();
		} catch (e) {
			console.error(e);
			addToast(`Failed to add to playlist`, "error");
		}
	};

	const handleCreateAndAdd = async (
		e: React.SyntheticEvent<HTMLFormElement>,
	) => {
		e.preventDefault();
		if (!newPlaylistName.trim()) return;

		try {
			const newPlaylist = await createPlaylist(newPlaylistName.trim());
			await addToPlaylist(newPlaylist.id, [track.id]);

			const updatedPlaylists = await getPlaylists();
			setPlaylists(updatedPlaylists);

			addToast(`Added to ${newPlaylist.name}`, "success");
			onClose();
		} catch (e) {
			console.error(e);
			addToast(`Failed to create playlist`, "error");
		}
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div
				className="modal-content glass-panel-heavy add-playlist-modal"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-header">
					<h2>Add to Playlist</h2>
					<button className="icon-btn" onClick={onClose}>
						<X size={20} />
					</button>
				</div>

				<div className="modal-track-preview">
					<div className="track-title truncate">{track.title}</div>
					<div className="track-artist truncate">{track.artist}</div>
				</div>

				<div className="playlist-selection-wrapper scrollbar-host">
					<div className="playlist-selection-list" ref={playlistListRef}>
						{!isCreating && (
							<button
								className="playlist-list-item new-playlist-btn"
								onClick={() => setIsCreating(true)}
							>
								<div className="playlist-icon-wrapper">
									<Plus size={16} />
								</div>
								<span>New Playlist...</span>
							</button>
						)}

						{isCreating && (
							<form onSubmit={handleCreateAndAdd} className="new-playlist-form">
								<input
									type="text"
									autoFocus
									placeholder="Playlist name"
									className="search-input"
									value={newPlaylistName}
									onChange={(e) => setNewPlaylistName(e.target.value)}
								/>
								<div className="form-actions">
									<button
										type="button"
										className="btn"
										onClick={() => setIsCreating(false)}
									>
										Cancel
									</button>
									<button
										type="submit"
										className="btn btn-primary"
										disabled={!newPlaylistName.trim()}
									>
										Create
									</button>
								</div>
							</form>
						)}

						{playlists.map((playlist) => (
							<button
								key={playlist.id}
								className="playlist-list-item"
								onClick={() => handleAddToPlaylist(playlist.id, playlist.name)}
							>
								<div className="playlist-icon-wrapper">
									<ListMusic size={16} />
								</div>
								<div className="playlist-list-info">
									<span className="playlist-list-name truncate">
										{playlist.name}
									</span>
									<span className="playlist-list-count">
										{playlist.track_count} songs
									</span>
								</div>
							</button>
						))}

						{playlists.length === 0 && !isCreating && (
							<div className="empty-playlists-msg">
								No playlists found. Create one above!
							</div>
						)}
					</div>
					<CustomScrollbar scrollRef={playlistListRef} />
				</div>
			</div>
		</div>
	);
}

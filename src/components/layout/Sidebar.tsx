import {
	Home,
	Music,
	Disc,
	Mic2,
	ListMusic,
	Settings,
	FolderPlus,
	ListPlus,
	Trash2,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import {
	createPlaylist,
	getPlaylists,
	deletePlaylist,
	getPlaylistTracks,
	addToQueue,
} from "../../utils/tauri";
import { useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu";
import type { Playlist } from "../../types";
import { useState } from "react";
import FolderManagementModal from "../ui/FolderManagementModal";
import SettingsModal from "../ui/SettingsModal";
import "./Sidebar.css";

export default function Sidebar() {
	const {
		activeSection,
		setActiveSection,
		activeLibraryView,
		setActiveLibraryView,
		activePlaylist,
		setActivePlaylist,
	} = useUiStore();
	const { isScanning, playlists, setPlaylists } = useLibraryStore();
	const { addToast } = useToastStore();

	const [isCreateModalOpen, setCreateModalOpen] = useState(false);
	const [newPlaylistName, setNewPlaylistName] = useState("");

	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	const [contextPlaylist, setContextPlaylist] = useState<Playlist | null>(null);
	const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
	const [isFolderModalOpen, setFolderModalOpen] = useState(false);
	const [isSettingsOpen, setSettingsOpen] = useState(false);

	const handleCreatePlaylist = async (
		e: React.SyntheticEvent<HTMLFormElement>,
	) => {
		e.preventDefault();
		if (!newPlaylistName.trim()) return;

		try {
			await createPlaylist(newPlaylistName.trim());
			const updatedPlaylists = await getPlaylists();
			setPlaylists(updatedPlaylists);
			setCreateModalOpen(false);
			setNewPlaylistName("");
		} catch (error) {
			console.error("Failed to create playlist:", error);
		}
	};

	const handleContextMenu = (e: React.MouseEvent, playlist: Playlist) => {
		e.preventDefault();
		setContextPlaylist(playlist);
		setMenuPos({ x: e.clientX, y: e.clientY });
	};

	const handleAddToQueue = async () => {
		if (!contextPlaylist) return;
		try {
			const tracks = await getPlaylistTracks(contextPlaylist.id);
			if (tracks.length === 0) return;

			let addedCount = 0;
			for (const track of tracks) {
				try {
					await addToQueue(track);
					addedCount++;
				} catch (err) {
					console.error("Failed to add track to queue", err);
				}
			}

			if (addedCount > 0) {
				addToast(`Added ${addedCount} tracks to queue`, "success");
			}
		} catch (err) {
			console.error("Failed to fetch playlist tracks:", err);
			addToast("Failed to add to queue", "error");
		}
		setMenuPos(null);
	};

	const handleDeletePlaylist = async () => {
		if (!contextPlaylist) return;

		try {
			await deletePlaylist(contextPlaylist.id);
			const updatedPlaylists = await getPlaylists();
			setPlaylists(updatedPlaylists);
			addToast(`Deleted playlist "${contextPlaylist.name}"`, "success");

			// Navigate away if it was the active one
			if (activePlaylist?.id === contextPlaylist.id) {
				setActivePlaylist(null);
				setActiveSection("home");
			}
			setIsDeleteModalOpen(false);
			setContextPlaylist(null);
		} catch (err) {
			console.error("Failed to delete playlist:", err);
			addToast("Failed to delete playlist", "error");
		}
	};

	const menuItems: ContextMenuItem[] = [
		{
			label: "Add to Queue",
			icon: <ListPlus size={14} />,
			onClick: handleAddToQueue,
		},
		{
			label: "Delete Playlist",
			icon: <Trash2 size={14} />,
			isDanger: true,
			onClick: () => {
				setIsDeleteModalOpen(true);
				setMenuPos(null);
			},
		},
	];

	return (
		<aside className="sidebar">
			<div className="sidebar-scroll">
				<nav className="sidebar-nav">
					<div className="nav-section">
						<button
							className={`nav-item ${activeSection === "home" ? "active" : ""}`}
							onClick={() => setActiveSection("home")}
						>
							<Home size={20} />
							<span>Home</span>
						</button>
					</div>

					<div className="nav-section">
						<div className="section-header">
							<h3 className="section-title">Library</h3>
						</div>
						<button
							className={`nav-item ${activeSection === "library" && activeLibraryView === "songs" ? "active" : ""}`}
							onClick={() => {
								setActiveSection("library");
								setActiveLibraryView("songs");
							}}
						>
							<Music size={20} />
							<span>Songs</span>
						</button>
						<button
							className={`nav-item ${activeSection === "library" && activeLibraryView === "albums" ? "active" : ""}`}
							onClick={() => {
								setActiveSection("library");
								setActiveLibraryView("albums");
							}}
						>
							<Disc size={20} />
							<span>Albums</span>
						</button>
						<button
							className={`nav-item ${activeSection === "library" && activeLibraryView === "artists" ? "active" : ""}`}
							onClick={() => {
								setActiveSection("library");
								setActiveLibraryView("artists");
							}}
						>
							<Mic2 size={20} />
							<span>Artists</span>
						</button>
					</div>

					<div className="nav-section">
						<div className="section-header">
							<h3 className="section-title">Playlists</h3>
							<button
								className="icon-btn section-action"
								onClick={() => setCreateModalOpen(true)}
								title="New Playlist"
							>
								<FolderPlus size={16} />
							</button>
						</div>

						{playlists.map((playlist) => (
							<button
								key={playlist.id}
								className={`nav-item ${activeSection === "playlist" && activePlaylist?.id === playlist.id ? "active" : ""}`}
								onClick={() => {
									setActiveSection("playlist");
									setActivePlaylist(playlist);
								}}
								onContextMenu={(e) => handleContextMenu(e, playlist)}
							>
								<ListMusic size={20} />
								<span className="truncate">{playlist.name}</span>
							</button>
						))}
					</div>
				</nav>
			</div>

			<div className="sidebar-footer">
				<button
					className="sidebar-action-btn"
					onClick={() => setFolderModalOpen(true)}
					disabled={isScanning}
				>
					<FolderPlus size={18} />
					<span>{isScanning ? "Scanning..." : "Add Music"}</span>
				</button>
				<button
					className="icon-btn"
					title="Settings"
					onClick={() => setSettingsOpen(true)}
				>
					<Settings size={20} />
				</button>
			</div>

			{/* Simple Create Playlist Modal */}
			{isCreateModalOpen && (
				<div
					className="modal-overlay"
					onClick={() => setCreateModalOpen(false)}
				>
					<div
						className="modal-content glass-panel-heavy create-playlist-modal"
						onClick={(e) => e.stopPropagation()}
					>
						<h2 style={{ marginBottom: "var(--space-lg)" }}>New Playlist</h2>
						<form onSubmit={handleCreatePlaylist}>
							<input
								type="text"
								value={newPlaylistName}
								onChange={(e) => setNewPlaylistName(e.target.value)}
								placeholder="Playlist name"
								autoFocus
								className="search-input"
								style={{ width: "100%", marginBottom: "var(--space-lg)" }}
							/>
							<div
								style={{
									display: "flex",
									justifyContent: "flex-end",
									gap: "var(--space-md)",
								}}
							>
								<button
									type="button"
									className="btn btn-ghost"
									onClick={() => setCreateModalOpen(false)}
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
					</div>
				</div>
			)}

			<FolderManagementModal
				isOpen={isFolderModalOpen}
				onClose={() => setFolderModalOpen(false)}
			/>

			<SettingsModal
				isOpen={isSettingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>

			{/* Context Menu */}
			{menuPos && (
				<ContextMenu
					items={menuItems}
					x={menuPos.x}
					y={menuPos.y}
					onClose={() => setMenuPos(null)}
				/>
			)}

			{/* Delete Confirmation Modal */}
			{isDeleteModalOpen && contextPlaylist && (
				<div
					className="modal-overlay"
					onClick={() => setIsDeleteModalOpen(false)}
				>
					<div
						className="modal-content glass-panel-heavy"
						onClick={(e) => e.stopPropagation()}
					>
						<h2 style={{ marginBottom: "var(--space-md)" }}>Delete Playlist</h2>
						<p
							style={{
								color: "var(--text-secondary)",
								marginBottom: "var(--space-xl)",
							}}
						>
							Are you sure you want to delete "{contextPlaylist.name}"? This
							action cannot be undone.
						</p>
						<div
							style={{
								display: "flex",
								justifyContent: "flex-end",
								gap: "var(--space-md)",
							}}
						>
							<button
								className="btn btn-ghost"
								onClick={() => setIsDeleteModalOpen(false)}
							>
								Cancel
							</button>
							<button
								className="btn btn-primary"
								style={{ background: "var(--danger)" }}
								onClick={handleDeletePlaylist}
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			)}
		</aside>
	);
}

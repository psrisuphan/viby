import { useEffect, useRef, useState } from "react";
import { X, Folder, Trash2, Plus, Music, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "../../stores/toastStore";
import { useLibraryStore } from "../../stores/libraryStore";
import {
	getAllTracks,
	getAlbums,
	getArtists,
	getPlaylists,
} from "../../utils/tauri";
import CustomScrollbar from "./CustomScrollbar";
import "./FolderManagementModal.css";

interface Props {
	isOpen: boolean;
	onClose: () => void;
}

export default function FolderManagementModal({ isOpen, onClose }: Props) {
	const [folders, setFolders] = useState<string[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const folderListRef = useRef<HTMLDivElement>(null);

	const fetchFolders = async () => {
		try {
			const result = await invoke<string[]>("get_library_folders");
			setFolders(result);
		} catch (err) {
			console.error("Failed to fetch folders:", err);
			useToastStore
				.getState()
				.addToast("Failed to load music folders", "error");
		}
	};

	useEffect(() => {
		if (isOpen) {
			fetchFolders();
		}
	}, [isOpen]);

	const handleAddFolder = async () => {
		try {
			setIsLoading(true);
			const paths = await invoke<string[]>("pick_library_folders");
			if (paths.length === 0) return;

			await fetchFolders();
			useToastStore
				.getState()
				.addToast("Folder(s) added. Scanning library...", "info");
			await invoke("scan_library");
		} catch (err: any) {
			useToastStore
				.getState()
				.addToast(err.toString() || "Failed to add folder", "error");
		} finally {
			setIsLoading(false);
		}
	};

	const handleRemoveFolder = async (path: string) => {
		try {
			setIsLoading(true);
			await invoke("remove_library_folder", { path });
			await fetchFolders();
			const [tracks, albums, artists, playlists] = await Promise.all([
				getAllTracks(),
				getAlbums(),
				getArtists(),
				getPlaylists(),
			]);
			useLibraryStore
				.getState()
				.setLibraryData({ tracks, albums, artists, playlists });
			useToastStore
				.getState()
				.addToast("Folder and its tracks removed.", "success");
		} catch (err: any) {
			useToastStore
				.getState()
				.addToast(err.toString() || "Failed to remove folder", "error");
		} finally {
			setIsLoading(false);
		}
	};

	const handleReloadNow = async () => {
		try {
			setIsLoading(true);
			useToastStore.getState().addToast("Scanning folders...", "info");
			await invoke("scan_library");
			useToastStore.getState().addToast("Scan complete", "success");
		} catch (err: any) {
			useToastStore
				.getState()
				.addToast(err.toString() || "Scan failed", "error");
		} finally {
			setIsLoading(false);
		}
	};

	if (!isOpen) return null;

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div
				className="modal-content glass-panel-heavy folder-management-modal"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="folder-management-header">
					<h2>Music Folders</h2>
					<button className="icon-btn" onClick={onClose}>
						<X size={20} />
					</button>
				</div>

				<div className="folder-list-wrapper scrollbar-host">
					<div className="folder-list" ref={folderListRef}>
						{folders.length === 0 ? (
							<div className="folder-empty-state">
								<Music size={48} opacity={0.5} />
								<p>
									No music folders added yet. Add a folder to start building
									your library.
								</p>
							</div>
						) : (
							folders.map((path, idx) => (
								<div key={`${path}-${idx}`} className="folder-item">
									<div className="folder-item-info">
										<Folder className="folder-item-icon" size={18} />
										<span className="folder-item-path" title={path}>
											{path}
										</span>
									</div>
									<button
										className="icon-btn--sm folder-item-remove"
										onClick={() => handleRemoveFolder(path)}
										disabled={isLoading}
										title="Remove Folder"
									>
										<Trash2 size={16} />
									</button>
								</div>
							))
						)}
					</div>
					<CustomScrollbar scrollRef={folderListRef} />
				</div>

				<div
					className="folder-management-footer"
					style={{ gap: "var(--space-md)" }}
				>
					<button
						className="btn btn-ghost"
						onClick={handleReloadNow}
						disabled={isLoading || folders.length === 0}
						style={{ display: "flex", alignItems: "center", gap: "8px" }}
					>
						<RefreshCw
							size={16}
							className={isLoading ? "spin-animation" : ""}
						/>
						<span>Scan Now</span>
					</button>
					<button
						className="btn btn-primary"
						onClick={handleAddFolder}
						disabled={isLoading}
						style={{ display: "flex", alignItems: "center", gap: "8px" }}
					>
						<Plus size={16} />
						<span>Add Folder</span>
					</button>
				</div>
			</div>
		</div>
	);
}

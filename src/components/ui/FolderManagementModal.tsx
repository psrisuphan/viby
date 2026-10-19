import { useEffect, useRef, useState } from "react";
import { X, Folder, Trash2, Plus, Music, RefreshCw } from "lucide-react";
import { useToastStore } from "../../stores/toastStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { formatInvokeError } from "../../utils/errorMessage";
import {
  describeScanStartFailure,
  isScanStartFailure,
} from "../../utils/scanStartFailure";
import {
  getLibraryFolders,
  getAllTracks,
  getAlbums,
  getArtists,
  getPlaylists,
  pickLibraryFolders,
  removeLibraryFolder,
  scanLibrary,
} from "../../utils/tauri";
import CustomScrollbar from "./CustomScrollbar";
import AccessibleDialog from "./AccessibleDialog";
import ConfirmDialog from "./ConfirmDialog";
import "./FolderManagementModal.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function FolderManagementModal({ isOpen, onClose }: Props) {
  const [folders, setFolders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [folderToRemove, setFolderToRemove] = useState<string | null>(null);
  const folderListRef = useRef<HTMLDivElement>(null);

  const fetchFolders = async () => {
    try {
      const result = await getLibraryFolders();
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
      const paths = await pickLibraryFolders();
      if (paths.length === 0) return;

      await fetchFolders();
      useToastStore
        .getState()
        .addToast("Folder(s) added. Scanning library...", "info");
      try {
        await scanLibrary();
      } catch (err) {
        if (isScanStartFailure(err)) {
          useToastStore
            .getState()
            .addToast(describeScanStartFailure(err), "error");
        }
      }
    } catch (err: unknown) {
      useToastStore
        .getState()
        .addToast(formatInvokeError(err, "Failed to add folder"), "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveFolder = async (path: string) => {
    try {
      setIsLoading(true);
      await removeLibraryFolder(path);
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
    } catch (err: unknown) {
      useToastStore
        .getState()
        .addToast(formatInvokeError(err, "Failed to remove folder"), "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleReloadNow = async () => {
    try {
      setIsLoading(true);
      useToastStore.getState().addToast("Scanning folders...", "info");
      const result = await scanLibrary();
      const hasIssues =
        result.partial_success === true ||
        (result.skipped_files ?? 0) > 0 ||
        (result.failed_folders ?? 0) > 0 ||
        (result.folder_errors?.length ?? 0) > 0 ||
        (result.file_errors?.length ?? 0) > 0;
      if (result.status === "complete" && !hasIssues && !result.message) {
        useToastStore.getState().addToast("Scan complete", "success");
      }
    } catch (err) {
      if (isScanStartFailure(err)) {
        useToastStore
          .getState()
          .addToast(describeScanStartFailure(err), "error");
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AccessibleDialog
      ariaLabel="Music folders"
      overlayClassName="modal-overlay"
      contentClassName="modal-content glass-panel-heavy folder-management-modal"
      onClose={onClose}
    >
      <div className="folder-management-header">
        <h2>Music Folders</h2>
        <button
          className="icon-btn"
          aria-label="Close music folders"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>

      <div className="folder-list-wrapper scrollbar-host">
        <div className="folder-list" ref={folderListRef}>
          {folders.length === 0 ? (
            <div className="folder-empty-state">
              <Music size={48} opacity={0.5} />
              <p>
                No music folders added yet. Add a folder to start building your
                library.
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
                  onClick={() => setFolderToRemove(path)}
                  disabled={isLoading}
                  aria-label={`Remove folder ${path}`}
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
          <RefreshCw size={16} className={isLoading ? "spin-animation" : ""} />
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
      {folderToRemove && (
        <ConfirmDialog
          title="Remove music folder?"
          description={`Remove “${folderToRemove}” from your library? The audio files will stay on disk, but Viby will no longer include this folder.`}
          confirmLabel="Remove folder"
          onConfirm={() => {
            const path = folderToRemove;
            setFolderToRemove(null);
            void handleRemoveFolder(path);
          }}
          onCancel={() => setFolderToRemove(null)}
        />
      )}
    </AccessibleDialog>
  );
}

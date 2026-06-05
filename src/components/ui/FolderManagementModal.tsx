import { useEffect, useState } from 'react';
import { X, Folder, Trash2, Plus, Music } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useToastStore } from '../../stores/toastStore';
import './FolderManagementModal.css';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function FolderManagementModal({ isOpen, onClose }: Props) {
  const [folders, setFolders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchFolders = async () => {
    try {
      const result = await invoke<string[]>('get_library_folders');
      setFolders(result);
    } catch (err) {
      console.error('Failed to fetch folders:', err);
      useToastStore.getState().addToast('Failed to load music folders', 'error');
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchFolders();
    }
  }, [isOpen]);

  const handleAddFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: true,
        title: 'Select Music Folders'
      });
      
      if (!selected) return;

      setIsLoading(true);
      const paths = Array.isArray(selected) ? selected : [selected];
      
      for (const path of paths) {
        await invoke('add_library_folder', { path });
      }

      await fetchFolders();
      useToastStore.getState().addToast('Folder(s) added. Scanning library...', 'info');
      await invoke('scan_library');
    } catch (err: any) {
      useToastStore.getState().addToast(err.toString() || 'Failed to add folder', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveFolder = async (path: string) => {
    try {
      setIsLoading(true);
      await invoke('remove_library_folder', { path });
      await fetchFolders();
      useToastStore.getState().addToast('Folder removed. Updating library...', 'info');
      await invoke('scan_library');
    } catch (err: any) {
      useToastStore.getState().addToast(err.toString() || 'Failed to remove folder', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel-heavy folder-management-modal" onClick={e => e.stopPropagation()}>
        <div className="folder-management-header">
          <h2>Music Folders</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="folder-list">
          {folders.length === 0 ? (
            <div className="folder-empty-state">
              <Music size={48} opacity={0.5} />
              <p>No music folders added yet. Add a folder to start building your library.</p>
            </div>
          ) : (
            folders.map((path, idx) => (
              <div key={`${path}-${idx}`} className="folder-item">
                <div className="folder-item-info">
                  <Folder className="folder-item-icon" size={18} />
                  <span className="folder-item-path" title={path}>{path}</span>
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

        <div className="folder-management-footer">
          <button 
            className="btn btn-primary" 
            onClick={handleAddFolder}
            disabled={isLoading}
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <Plus size={16} />
            <span>Add Folder</span>
          </button>
        </div>
      </div>
    </div>
  );
}

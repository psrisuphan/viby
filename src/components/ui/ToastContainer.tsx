import { useToastStore } from '../../stores/toastStore';
import { X, CheckCircle, Info, AlertCircle } from 'lucide-react';
import './ToastContainer.css';

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const announcement = useToastStore((s) => s.currentAnnouncement);
  const removeToast = useToastStore((s) => s.removeToast);

  const announcementText = announcement
    ? `${announcement.type === 'error' ? 'Error' : announcement.type}: ${announcement.message}`
    : '';

  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      <div className="toast-announcer" aria-live="polite" aria-atomic="true">
        {announcement?.type !== 'error' ? announcementText : ''}
      </div>
      <div className="toast-announcer" aria-live="assertive" aria-atomic="true">
        {announcement?.type === 'error' ? announcementText : ''}
      </div>
      <div className="toast-list" aria-live="off">
      {toasts.map((toast) => {
        const Icon = toast.type === 'success' ? CheckCircle :
                     toast.type === 'error' ? AlertCircle : Info;
        
        return (
          <div key={toast.id} className={`toast toast-${toast.type} animate-slide-up`}>
            <div className="toast-icon">
              <Icon size={18} aria-hidden="true" />
            </div>
            <div className="toast-message">{toast.message}</div>
            <button
              type="button"
              className="toast-close"
              onClick={() => removeToast(toast.id)}
              aria-label={`Dismiss ${toast.type} notification: ${toast.message}`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      </div>
    </div>
  );
}

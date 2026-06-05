import { useToastStore } from '../../stores/toastStore';
import { X, CheckCircle, Info, AlertCircle } from 'lucide-react';
import './ToastContainer.css';

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => {
        const Icon = toast.type === 'success' ? CheckCircle :
                     toast.type === 'error' ? AlertCircle : Info;
        
        return (
          <div key={toast.id} className={`toast toast-${toast.type} animate-slide-up`}>
            <div className="toast-icon">
              <Icon size={18} />
            </div>
            <div className="toast-message">{toast.message}</div>
            <button className="toast-close" onClick={() => removeToast(toast.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

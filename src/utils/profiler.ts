export interface ProfileEvent {
  timestamp: number;
  timeStr: string;
  type: 'render' | 'click' | 'tauri_event' | 'error' | 'ipc';
  message: string;
  details?: any;
}

const logs: ProfileEvent[] = [];
const listeners = new Set<() => void>();

export function subscribeToProfiler(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function notifyListeners() {
  listeners.forEach(cb => cb());
}

export function logProfileEvent(type: ProfileEvent['type'], message: string, details?: any) {
  const now = new Date();
  const timeStr = `${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const event: ProfileEvent = {
    timestamp: performance.now(),
    timeStr,
    type,
    message,
    details
  };
  logs.push(event);
  if (logs.length > 500) {
    logs.shift();
  }
  
  // Format nicely and log to console so it prints in Tauri stdout / terminal
  const logPrefix = `[VibyProfiler][${type.toUpperCase()}][${timeStr}]`;
  if (type === 'error') {
    console.error(logPrefix, message, details ? JSON.stringify(details) : '');
  } else if (type === 'tauri_event' || type === 'ipc') {
    console.warn(logPrefix, message, details ? JSON.stringify(details) : '');
  } else {
    console.info(logPrefix, message, details ? JSON.stringify(details) : '');
  }

  notifyListeners();
}

export function getProfileLogs(): ProfileEvent[] {
  return [...logs];
}

export function clearProfileLogs() {
  logs.length = 0;
  notifyListeners();
}

// Global error capture
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    logProfileEvent('error', `Unhandled window error: ${event.message}`, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack || event.error
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    logProfileEvent('error', `Unhandled Promise rejection: ${event.reason}`, {
      stack: event.reason?.stack || event.reason
    });
  });
}

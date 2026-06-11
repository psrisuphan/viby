import { invoke } from '@tauri-apps/api/core';

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

let flushTimeout: ReturnType<typeof setTimeout> | null = null;

export async function flushLogsToDisk() {
  if (!import.meta.env.DEV) return;
  const logString = logs
    .map(log => `[${log.timeStr}][${log.type.toUpperCase()}] ${log.message}${log.details ? ' ' + JSON.stringify(log.details) : ''}`)
    .join('\n');
  try {
    await invoke('write_log_to_disk', { logContent: logString });
    console.info('[VibyProfiler] Flushed logs to disk successfully.');
  } catch (err) {
    console.error('[VibyProfiler] Failed to flush logs to disk:', err);
  }
}

export function queueLogsFlush() {
  if (flushTimeout || !import.meta.env.DEV) return;
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    flushLogsToDisk();
  }, 2000);
}

export function logProfileEvent(type: ProfileEvent['type'], message: string, details?: any) {
  if (!import.meta.env.DEV) return;

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

  // Immediately flush errors, queue up a throttled write for other events (excluding renders)
  if (type === 'error') {
    flushLogsToDisk();
  } else if (type !== 'render') {
    queueLogsFlush();
  }
}

export function getProfileLogs(): ProfileEvent[] {
  return [...logs];
}

export function clearProfileLogs() {
  logs.length = 0;
  notifyListeners();
  flushLogsToDisk();
}

// Global error and window unload capture
if (typeof window !== 'undefined' && import.meta.env.DEV) {
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

  window.addEventListener('beforeunload', () => {
    logProfileEvent('ipc', 'Window beforeunload triggered - flushing logs to disk');
    // Can't await inside beforeunload, but standard sync/async IPC invoke starts immediately
    flushLogsToDisk();
  });
}

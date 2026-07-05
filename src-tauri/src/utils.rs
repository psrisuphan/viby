/// Returns the current UTC time as an ISO 8601 string (e.g. "2024-01-15T10:30:00Z").
pub fn current_timestamp() -> String {
    let now = std::time::SystemTime::now();
    let since_epoch = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs();

    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let (year, month, day) = days_to_date(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Converts days since Unix epoch (1970-01-01) to (year, month, day).
/// Algorithm based on Howard Hinnant's civil_from_days.
fn days_to_date(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn get_app_data_dir() -> std::path::PathBuf {
    let identifier = "com.viby.app";
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        let mut path = std::path::PathBuf::from(home);
        path.push("Library");
        path.push("Application Support");
        path.push(identifier);
        return path;
    }
    if let Ok(home) = std::env::var("HOME") {
        let mut path = std::path::PathBuf::from(home);
        path.push(".local");
        path.push("share");
        path.push(identifier);
        return path;
    }
    std::path::PathBuf::from(".")
}

pub fn log_rust_event(event_type: &str, message: &str) {
    let mut log_dir = get_app_data_dir();
    if std::fs::create_dir_all(&log_dir).is_ok() {
        log_dir.push("viby_profiler.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_dir)
        {
            let ts = current_timestamp();
            let log_line = format!("[{}][RUST_{}] {}\n", ts, event_type.to_uppercase(), message);
            let _ = std::io::Write::write_all(&mut file, log_line.as_bytes());
        }
    }
}

pub fn setup_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::capture();
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            *s
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.as_str()
        } else {
            "Unknown panic payload"
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let log_message = format!(
            "\n================ RUST PANIC =================\n\
             Timestamp: {}\n\
             Panic occurred at: {}\n\
             Message: {}\n\
             Backtrace:\n{:?}\n\
             =============================================\n",
            current_timestamp(),
            location,
            message,
            backtrace
        );

        eprintln!("{}", log_message);

        let mut log_dir = get_app_data_dir();
        if std::fs::create_dir_all(&log_dir).is_ok() {
            log_dir.push("viby_profiler.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_dir)
            {
                let _ = std::io::Write::write_all(&mut file, log_message.as_bytes());
            }
        }
    }));
}

/// Install signal handlers that capture fatal native crashes (SIGSEGV, SIGABRT, SIGBUS).
/// These bypass the Rust panic hook entirely, so without this handler we get no log at all.
/// The handler writes a marker to the profiler log using only async-signal-safe syscalls,
/// then re-raises the signal so the OS produces the default core dump / exit.
#[cfg(target_family = "unix")]
pub fn setup_crash_signal_handler() {
    use std::sync::atomic::{AtomicBool, Ordering};

    // Guard against re-entrant signals (e.g. SIGSEGV inside the handler itself).
    static IN_HANDLER: AtomicBool = AtomicBool::new(false);

    extern "C" fn crash_handler(sig: libc::c_int) {
        // Prevent re-entrant invocation — just abort immediately.
        if IN_HANDLER.swap(true, Ordering::SeqCst) {
            unsafe {
                libc::_exit(128 + sig);
            }
        }

        // Build a minimal message using only stack memory (no heap allocation).
        // This is critical: malloc is NOT async-signal-safe and would deadlock.
        let sig_name = match sig {
            libc::SIGSEGV => "SIGSEGV (Segmentation fault)",
            libc::SIGABRT => "SIGABRT (Abort)",
            libc::SIGBUS => "SIGBUS (Bus error)",
            _ => "UNKNOWN SIGNAL",
        };

        // Write to stderr (fd 2) — async-signal-safe.
        let header = b"\n================ NATIVE CRASH =================\n";
        let signal_label = b"Signal: ";
        let newline = b"\n";
        let footer = b"================================================\n";
        unsafe {
            libc::write(2, header.as_ptr() as *const libc::c_void, header.len());
            libc::write(
                2,
                signal_label.as_ptr() as *const libc::c_void,
                signal_label.len(),
            );
            libc::write(2, sig_name.as_ptr() as *const libc::c_void, sig_name.len());
            libc::write(2, newline.as_ptr() as *const libc::c_void, newline.len());
            libc::write(2, footer.as_ptr() as *const libc::c_void, footer.len());
        }

        // Also append to the profiler log file using raw syscalls.
        // We build the path on the stack to avoid heap allocation.
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            let mut path_buf = [0u8; 512];
            let prefix = home.as_bytes();
            let suffix = b"/.local/share/com.viby.app/viby_profiler.log";
            let total = prefix.len() + suffix.len();
            if total < path_buf.len() {
                path_buf[..prefix.len()].copy_from_slice(prefix);
                path_buf[prefix.len()..total].copy_from_slice(suffix);
                path_buf[total] = 0; // null-terminate

                unsafe {
                    let fd = libc::open(
                        path_buf.as_ptr() as *const libc::c_char,
                        libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT,
                        0o644,
                    );
                    if fd >= 0 {
                        libc::write(fd, header.as_ptr() as *const libc::c_void, header.len());
                        libc::write(
                            fd,
                            signal_label.as_ptr() as *const libc::c_void,
                            signal_label.len(),
                        );
                        libc::write(fd, sig_name.as_ptr() as *const libc::c_void, sig_name.len());
                        libc::write(fd, newline.as_ptr() as *const libc::c_void, newline.len());
                        libc::write(fd, footer.as_ptr() as *const libc::c_void, footer.len());
                        libc::close(fd);
                    }
                }
            }
        }

        // Re-raise with default handler so the OS produces a core dump / proper exit code.
        unsafe {
            libc::signal(sig, libc::SIG_DFL);
            libc::raise(sig);
        }
    }

    unsafe {
        let handler = crash_handler as *const () as libc::sighandler_t;
        libc::signal(libc::SIGSEGV, handler);
        libc::signal(libc::SIGABRT, handler);
        libc::signal(libc::SIGBUS, handler);
    }
}

#[cfg(not(target_family = "unix"))]
pub fn setup_crash_signal_handler() {
    // No-op on non-Unix platforms
}

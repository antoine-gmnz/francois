// Crash diagnostics — a single best-effort panic hook so a silent process death
// (main-thread panic aborts the whole app; a background-thread panic is
// otherwise invisible) leaves at least one trace behind.
//
// `append_log` generalizes the same idea to the non-fatal case: a subsystem that
// drives an external process has output nobody sees, and when that process just
// SITS there the output is the only witness. Same rules as the panic hook —
// best-effort, never panics, never blocks the caller on a failure.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// The app-data dir, recorded once at startup by `install_panic_log` so code
/// that holds no `AppHandle` (a stream parser thread) can still leave a trace.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Past this the file is restarted rather than grown without bound — these logs
/// are read right after a failure, so the recent end is the only useful end.
const MAX_LOG_BYTES: u64 = 1_000_000;

/// Appends one timestamped block to `<app_data>/<file>` and returns the path it
/// wrote, so a failure can NAME the file it just explained itself in. `None`
/// when there is no app-data dir or the write failed — a diagnostic that cannot
/// be written must never turn into a second failure.
pub fn append_log(app: &AppHandle, file: &str, block: &str) -> Option<String> {
    append_log_in(&app.path().app_data_dir().ok()?, file, block)
}

/// `append_log` for callers without an `AppHandle`: writes under the app-data
/// dir recorded at startup, `None` before that (or in tests, which never
/// install the panic hook).
pub fn append_app_log(file: &str, block: &str) -> Option<String> {
    append_log_in(LOG_DIR.get()?, file, block)
}

fn append_log_in(dir: &Path, file: &str, block: &str) -> Option<String> {
    std::fs::create_dir_all(dir).ok()?;
    let path: PathBuf = dir.join(file);
    if matches!(std::fs::metadata(&path), Ok(m) if m.len() > MAX_LOG_BYTES) {
        std::fs::remove_file(&path).ok();
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    writeln!(f, "[{ts}] {block}").ok()?;
    Some(path.to_string_lossy().to_string())
}

/// Any panic, on any thread, appends one line to `<app_data>/panic.log` before the
/// default handler runs. A main-thread panic aborts the whole app (the "it just
/// closed" report) and this file is the only trace it leaves; a background-thread
/// panic is otherwise completely silent. Best-effort — never panics itself.
pub fn install_panic_log(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir.clone());
    let path = dir.join("panic.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "[{ts}] panic on thread '{thread}': {info}");
        }
        default_hook(info);
    }));
}

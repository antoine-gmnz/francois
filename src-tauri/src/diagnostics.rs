// Crash diagnostics — a single best-effort panic hook so a silent process death
// (main-thread panic aborts the whole app; a background-thread panic is
// otherwise invisible) leaves at least one trace behind.

use std::io::Write;
use tauri::{AppHandle, Manager};

/// Any panic, on any thread, appends one line to `<app_data>/panic.log` before the
/// default handler runs. A main-thread panic aborts the whole app (the "it just
/// closed" report) and this file is the only trace it leaves; a background-thread
/// panic is otherwise completely silent. Best-effort — never panics itself.
pub fn install_panic_log(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
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

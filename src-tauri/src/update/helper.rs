//! FR-13..FR-18 — the generated relauncher.
//!
//! `applyUpdate` writes a self-contained helper into a FRESH temp directory
//! outside the npm package, spawns it detached, and quits. Outside is
//! load-bearing: npm replaces `node_modules/francois/` wholesale during the
//! install, and a helper executing from inside that directory can be deleted
//! under itself, or fail outright on Windows where the file is locked.
//!
//! The helper is a shell script rather than a second Rust binary for the same
//! reason the install itself is npm's job: it must survive the app being
//! replaced under it, and a `.cmd`/`.sh` in a temp directory owns nothing but
//! itself. It carries a tiny node sidecar (`reader_script`) so neither shell has
//! to parse JSON — node is guaranteed present, npm just ran through it.

use super::{EXIT_WAIT_SECS, PACKAGE, UPDATE_COMMAND};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The node sidecar that reads the post-install record (FR-14/FR-17).
const READER_NAME: &str = "read-record.js";
/// FR-15: everything the helper prints, so a failed update is diagnosable.
const LOG_NAME: &str = "update.log";

/// What `write_helper` laid down — the three absolute paths the spawn and the
/// ack need (FR-15).
pub(crate) struct HelperFiles {
    /// The relauncher itself: `.cmd` on Windows, `.sh` elsewhere (FR-13).
    pub script: PathBuf,
    /// The node sidecar that prints the recorded `executable`.
    pub reader: PathBuf,
    /// Where the helper's stdout+stderr go; echoed in the ack (FR-15).
    pub log: PathBuf,
}

/// A path as a `set "X=..."` value. `%` is the only character a quoted batch
/// assignment still expands, and `%%` is its literal form inside a script file.
fn batch_value(p: &Path) -> String {
    p.to_string_lossy().replace('%', "%%")
}

/// A path as a single-quoted POSIX literal — the only quoting that needs no
/// knowledge of what else is in the string.
fn sh_literal(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"))
}

/// A path as a single-quoted PowerShell literal, then batch-escaped: `cleanup`
/// hands the directory removal to PowerShell from inside the `.cmd`.
fn ps_value(p: &Path) -> String {
    p.to_string_lossy().replace('\'', "''").replace('%', "%%")
}

/// FR-14 (Windows). `tasklist` is the poll — the app is not this process's child
/// once it is detached, so there is nothing to wait on. `ping` is the sleep:
/// `timeout` needs a console and this runs with none (FR-15).
fn windows_script(pid: u32, exe: &Path, dir: &Path) -> String {
    let exe = batch_value(exe);
    let dir_value = batch_value(dir);
    let dir_ps = ps_value(dir);
    let wait = EXIT_WAIT_SECS;
    format!(
        r#"@echo off
setlocal enableextensions
rem Francois self-update helper, written by the app at update time (FR-13).
rem Waits for francois to quit, installs the new version through npm, relaunches
rem it, then deletes this directory. Everything below lands in {LOG_NAME}.
set "PID={pid}"
set "EXE={exe}"
set "DIR={dir_value}"
set "READER=%DIR%\{READER_NAME}"
set /a WAITED=0

echo [francois] waiting for pid %PID% to exit
:wait
tasklist /fi "PID eq %PID%" /nh 2>nul | find "%PID%" >nul
if errorlevel 1 goto gone
if %WAITED% GEQ {wait} goto giveup
set /a WAITED+=1
ping -n 2 127.0.0.1 >nul
goto wait

:giveup
rem The install is never attempted against a locked binary: give up, clean up,
rem leave the running app alone.
echo [francois] update abandoned: francois is still running after {wait} seconds.
goto cleanup

:gone
echo [francois] installing with {UPDATE_COMMAND}
call {UPDATE_COMMAND}
if errorlevel 1 goto npmfailed
rem FR-14: the new executable is whatever the postinstall just recorded. FR-17:
rem without a readable record the pre-update path set above still stands.
for /f "delims=" %%R in ('npm root -g') do set "NPMROOT=%%R"
set "RECORD=%NPMROOT%\{PACKAGE}\vendor\install.json"
if exist "%RECORD%" for /f "delims=" %%E in ('node "%READER%" "%RECORD%"') do set "EXE=%%E"

:relaunch
echo [francois] relaunching %EXE%
start "" "%EXE%"
goto cleanup

:npmfailed
echo [francois] npm failed - not relaunching. This log is kept at %DIR%\{LOG_NAME}
exit /b 1

:cleanup
rem A running .cmd cannot delete the directory it was read from, so the removal
rem is handed to a detached powershell that outlives this process by a moment.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 1500; Remove-Item -LiteralPath '{dir_ps}' -Recurse -Force -ErrorAction SilentlyContinue"
exit /b 0
"#
    )
}

/// FR-14 (macOS/Linux). `kill -0` is the poll; the give-up branch removes the
/// directory and exits WITHOUT running npm.
fn unix_script(pid: u32, exe: &Path, dir: &Path) -> String {
    let exe = sh_literal(exe);
    let dir_literal = sh_literal(dir);
    let wait = EXIT_WAIT_SECS;
    format!(
        r#"#!/bin/sh
# Francois self-update helper, written by the app at update time (FR-13).
# Waits for francois to quit, installs the new version through npm, relaunches
# it, then deletes this directory. Everything below lands in {LOG_NAME}.
PID={pid}
EXE={exe}
DIR={dir_literal}
READER="$DIR/{READER_NAME}"

echo "[francois] waiting for pid $PID to exit"
WAITED=0
while kill -0 "$PID" 2>/dev/null; do
  if [ "$WAITED" -ge {wait} ]; then
    # The install is never attempted against a locked binary.
    echo "[francois] update abandoned: francois is still running after {wait} seconds."
    rm -rf "$DIR"
    exit 1
  fi
  WAITED=$((WAITED + 1))
  sleep 1
done

echo "[francois] installing with {UPDATE_COMMAND}"
if ! {UPDATE_COMMAND}; then
  echo "[francois] npm failed - not relaunching. This log is kept at $DIR/{LOG_NAME}"
  exit 1
fi

# FR-14: the new executable is whatever the postinstall just recorded. FR-17:
# without a readable record the pre-update path set above still stands.
NPMROOT=$(npm root -g 2>/dev/null)
RECORD="$NPMROOT/{PACKAGE}/vendor/install.json"
if [ -n "$NPMROOT" ] && [ -f "$RECORD" ]; then
  NEW=$(node "$READER" "$RECORD" 2>/dev/null)
  if [ -n "$NEW" ]; then
    EXE="$NEW"
  fi
fi

echo "[francois] relaunching $EXE"
("$EXE" >/dev/null 2>&1 &)

rm -rf "$DIR"
exit 0
"#
    )
}

/// FR-14 as text. `windows` is a parameter rather than a `cfg!` so both scripts
/// are provable from either platform — the generated text is the whole contract
/// between the app and its own relauncher.
pub(crate) fn helper_script(pid: u32, exe: &Path, dir: &Path, windows: bool) -> String {
    if windows {
        windows_script(pid, exe, dir)
    } else {
        unix_script(pid, exe, dir)
    }
}

/// The node sidecar. Prints the recorded `executable` and NOTHING else — a
/// missing, unreadable or unexpected record prints nothing, which both scripts
/// read as "keep the pre-update path" (FR-17).
pub(crate) fn reader_script() -> String {
    String::from(
        r#"// francois self-update: print the executable the npm postinstall recorded.
// Any failure prints nothing at all, so the helper falls back to the path baked
// in before the update (FR-17).
try {
  const record = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  if (record && typeof record.executable === 'string' && record.executable) {
    process.stdout.write(record.executable);
  }
} catch (_) {
  // nothing to print
}
"#,
    )
}

/// FR-13: a fresh directory per call, in the system temp dir — never inside the
/// npm package, which the install replaces wholesale. The counter is what makes
/// two calls in the same nanosecond distinct.
pub(crate) fn fresh_helper_dir() -> std::io::Result<PathBuf> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "francois-update-{}-{nanos}-{seq}",
        std::process::id()
    ));
    fs::create_dir_all(&dir)?;
    // Defense-in-depth: the system temp dir is world-writable, so the
    // relauncher's own directory (which carries the pre-update executable
    // path and, briefly, its script) is restricted to this user.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// FR-13: lay the relauncher and its sidecar into `dir`, executable on unix.
pub(crate) fn write_helper(dir: &Path, pid: u32, exe: &Path) -> std::io::Result<HelperFiles> {
    let windows = cfg!(windows);
    let script = dir.join(if windows {
        "francois-update.cmd"
    } else {
        "francois-update.sh"
    });
    let reader = dir.join(READER_NAME);
    fs::write(&reader, reader_script())?;
    fs::write(&script, helper_script(pid, exe, dir, windows))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
    }
    Ok(HelperFiles {
        script,
        reader,
        log: dir.join(LOG_NAME),
    })
}

/// FR-15: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` — no console to flash,
/// and no membership in the group the exiting app belongs to.
#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// FR-15: `setsid()` in the child between fork and exec — the helper leads its
/// own session, so nothing that reaps the app's process group can take it down.
#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setsid` is async-signal-safe and allocates nothing, which is the
    // whole requirement on a pre_exec hook.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// FR-15: start the relauncher detached, stdout+stderr into `update.log`.
/// Returns its pid for the ack. The `Err` string is what `UPDATE_APPLY_FAILED`
/// carries (FR-18).
pub(crate) fn spawn_helper(files: &HelperFiles) -> Result<u32, String> {
    // FR-17: a missing sidecar is not fatal — the helper still installs and
    // relaunches, it just cannot re-read the post-install record and falls back
    // to the executable baked in before the update. Worth saying out loud,
    // since by the time it matters this process is gone.
    if !files.reader.is_file() {
        eprintln!(
            "update: no record reader at {}; the helper will relaunch the pre-update executable",
            files.reader.display()
        );
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&files.log)
        .map_err(|e| format!("Could not open the update log: {e}"))?;
    let errors = log
        .try_clone()
        .map_err(|e| format!("Could not open the update log: {e}"))?;

    let mut cmd = if cfg!(windows) {
        // A .cmd is not an executable image — cmd.exe has to run it.
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&files.script);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.arg(&files.script);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors));
    detach(&mut cmd);

    cmd.spawn()
        .map(|child| child.id())
        .map_err(|e| format!("Could not start the update helper: {e}"))
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use std::path::Path;

    fn win_script() -> String {
        helper_script(
            4242,
            Path::new(r"C:\Users\x\node_modules\francois\vendor\francois.exe"),
            Path::new(r"C:\Temp\francois-update-4242"),
            true,
        )
    }

    fn sh_script() -> String {
        helper_script(
            4242,
            Path::new("/Users/x/Applications/Francois.app/Contents/MacOS/francois"),
            Path::new("/tmp/francois-update-4242"),
            false,
        )
    }

    // FR-14 order: wait for the pid, then npm, then relaunch, then self-remove.
    #[test]
    fn windows_helper_runs_the_steps_in_order() {
        let s = win_script();
        let at = |needle: &str| {
            s.find(needle)
                .unwrap_or_else(|| panic!("missing: {needle}\n{s}"))
        };
        assert!(at("PID=4242") < at("npm i -g francois@latest"));
        assert!(at("npm i -g francois@latest") < at("install.json"));
        assert!(at("install.json") < at(":relaunch"));
        assert!(at(":relaunch") < at(":cleanup"));
    }

    #[test]
    fn unix_helper_runs_the_steps_in_order() {
        let s = sh_script();
        let at = |needle: &str| {
            s.find(needle)
                .unwrap_or_else(|| panic!("missing: {needle}\n{s}"))
        };
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(at("PID=4242") < at("npm i -g francois@latest"));
        assert!(at("npm i -g francois@latest") < at("install.json"));
        assert!(at("install.json") < at("relaunching $EXE"));
        assert!(at("relaunching $EXE") < s.rfind(r#"rm -rf "$DIR""#).unwrap());
    }

    // FR-14: the wait gives up after 120 s, and does so WITHOUT running npm —
    // the install is never attempted against a locked binary (§7).
    #[test]
    fn both_helpers_cap_the_wait_at_120_iterations() {
        assert_eq!(EXIT_WAIT_SECS, 120);
        assert!(win_script().contains("GEQ 120"));
        assert!(sh_script().contains("-ge 120"));
    }

    #[test]
    fn windows_helper_gives_up_without_installing() {
        let s = win_script();
        let giveup = s.find(":giveup").unwrap();
        let gone = s.find(":gone").unwrap();
        // The give-up branch jumps straight to cleanup; the npm call lives after it.
        assert!(giveup < gone, "{s}");
        assert!(s[giveup..gone].contains("goto cleanup"), "{s}");
        assert!(!s[giveup..gone].contains("npm i -g"), "{s}");
    }

    #[test]
    fn unix_helper_gives_up_without_installing() {
        let s = sh_script();
        let giveup = s.find("update abandoned").unwrap();
        let npm = s.find("npm i -g francois@latest").unwrap();
        assert!(giveup < npm, "{s}");
        assert!(s[giveup..npm].contains("exit 1"), "{s}");
    }

    // FR-14: on a non-zero npm exit the helper skips the relaunch and LEAVES the
    // log in place (no cleanup on that branch).
    #[test]
    fn windows_helper_keeps_the_log_when_npm_fails() {
        let s = win_script();
        assert!(s.contains("goto npmfailed"), "{s}");
        let failed = s.find(":npmfailed").unwrap();
        let tail = &s[failed..];
        let end = tail.find(":cleanup").unwrap_or(tail.len());
        assert!(!tail[..end].contains("start \"\" \"%EXE%\""), "{s}");
        assert!(tail[..end].contains("exit /b 1"), "{s}");
    }

    #[test]
    fn unix_helper_keeps_the_log_when_npm_fails() {
        let s = sh_script();
        assert!(
            s.contains("if ! npm i -g francois@latest; then"),
            "npm failure must short-circuit\n{s}"
        );
        let fail = s.find("not relaunching").unwrap();
        let relaunch = s.find("relaunching $EXE").unwrap();
        assert!(fail < relaunch, "{s}");
        assert!(s[fail..relaunch].contains("exit 1"), "{s}");
    }

    // FR-17: the pre-update executable is baked in and used when the post-install
    // record is missing or unreadable.
    #[test]
    fn both_helpers_bake_in_the_pre_update_executable() {
        assert!(win_script()
            .contains(r#"set "EXE=C:\Users\x\node_modules\francois\vendor\francois.exe""#));
        assert!(sh_script()
            .contains("EXE='/Users/x/Applications/Francois.app/Contents/MacOS/francois'"));
    }

    // FR-14: the new executable is re-read from `<npm root -g>/francois/vendor/install.json`.
    #[test]
    fn both_helpers_reread_the_install_record_from_npm_root() {
        assert!(win_script().contains(r"%NPMROOT%\francois\vendor\install.json"));
        assert!(win_script().contains("npm root -g"));
        assert!(sh_script().contains("$NPMROOT/francois/vendor/install.json"));
        assert!(sh_script().contains("npm root -g"));
    }

    // FR-13/FR-14: the helper removes its OWN temp directory — the one it was
    // written into, never the npm package.
    #[test]
    fn both_helpers_remove_their_own_temp_directory() {
        assert!(win_script().contains(r"C:\Temp\francois-update-4242"));
        assert!(win_script().contains("Remove-Item"));
        assert!(sh_script().contains("DIR='/tmp/francois-update-4242'"));
        assert!(sh_script().contains(r#"rm -rf "$DIR""#));
    }

    // A path with a quote in it must not break out of the shell literal.
    #[test]
    fn unix_helper_escapes_single_quotes_in_paths() {
        let s = helper_script(
            1,
            Path::new("/tmp/it's here/francois"),
            Path::new("/tmp/d"),
            false,
        );
        assert!(s.contains(r"EXE='/tmp/it'\''s here/francois'"), "{s}");
    }

    // The sidecar reader exists so neither script has to embed a JSON parser
    // (FR-14/FR-17) — node is guaranteed present, npm just ran through it.
    #[test]
    fn the_record_reader_prints_the_executable_field() {
        let js = reader_script();
        assert!(js.contains("process.argv[2]"), "{js}");
        assert!(js.contains(".executable"), "{js}");
        assert!(
            js.contains("catch"),
            "a missing record must print nothing\n{js}"
        );
    }

    // FR-13: a fresh directory per call, outside the npm package.
    #[test]
    fn each_helper_gets_its_own_temp_directory() {
        let a = fresh_helper_dir().unwrap();
        let b = fresh_helper_dir().unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        assert!(a.starts_with(std::env::temp_dir()));
        assert!(!a.to_string_lossy().contains("node_modules"));
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    // Defense-in-depth: the world-writable system temp dir is not a safe default
    // for a directory holding the relauncher and its pre-update executable path.
    #[cfg(unix)]
    #[test]
    fn the_helper_directory_is_restricted_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_helper_dir().unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).ok();
    }

    // FR-13: mode 0o755 on unix; the script and its sidecar land in the directory.
    #[test]
    fn writing_the_helper_lays_down_an_executable_script() {
        let dir = fresh_helper_dir().unwrap();
        let plan = write_helper(&dir, 4242, Path::new("/tmp/francois")).unwrap();
        assert!(plan.script.is_file());
        assert!(plan.reader.is_file());
        assert_eq!(plan.log, dir.join("update.log"));
        assert_eq!(
            plan.script.extension().unwrap(),
            if cfg!(windows) { "cmd" } else { "sh" }
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&plan.script)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}

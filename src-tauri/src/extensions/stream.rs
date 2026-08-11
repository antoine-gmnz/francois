//! FR-38..FR-45 — live `log-tail` streams.
//!
//! A stream is the only long-lived process this feature owns, and everything
//! about it is addressed by a core-minted `StreamId` (FR-44) so a late chunk
//! from a killed stream can never append to a new one. One live stream per panel
//! (FR-42): opening a second closes the first, including when only the target
//! changed.
//!
//! The single `token` slot in the system lands here and nowhere else (FR-38).
//! The core RE-VALIDATES it against `TOKEN_PATTERN` and never trusts the
//! frontend's check, and a `file` source may only open paths that resolve —
//! after symlinks — under the panel's declared root (FR-39).

use super::provider::{kill_group, own_process_group, render_args, scrub_env};
use super::schema::sanitize_line;
use super::{emit, ExtensionEvent, PathSeg, Source, EXT_LOG_MAX_LINES};
use crate::process_util::no_window;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// How often a `file` source looks for new bytes. A poll rather than a watcher:
/// a loop log is appended to by another process on the same machine, and 400 ms
/// is imperceptible next to the work it is reporting on.
const FILE_POLL_MS: u64 = 400;

// ---------- FR-38: the token slot ----------

/// `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`, re-implemented as a char scan (the
/// crate carries no regex dependency). The leading class excludes `-`, so
/// argument injection is structurally impossible rather than filtered, and it
/// excludes `/`, `\` and a leading `.` so a token can never walk a path either.
pub(crate) fn valid_token(token: &str) -> bool {
    let mut chars = token.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    let mut len = 1;
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            return false;
        }
        len += 1;
        if len > 128 {
            return false;
        }
    }
    true
}

// ---------- FR-39: containment ----------

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SourceError {
    /// FR-39: the resolved path escaped the panel's declared root. NO handle is
    /// opened — the check happens before the file is touched.
    OutsideRoot,
    /// The panel's declared root itself does not resolve (e.g. the project
    /// directory was deleted or unmounted after the panel was registered).
    /// Distinct from `OutsideRoot` — the failure isn't a containment breach,
    /// it's that there is no longer a root to be contained by, and the two
    /// deserve different messages at the call site.
    RootMissing,
}

/// The relative path a `file` source declares, with its single token filled in.
/// Pure — the segments are compiled in and the token has already been validated.
pub(crate) fn file_rel_path(segs: &[PathSeg], token: &str) -> String {
    segs.iter()
        .map(|s| match s {
            PathSeg::Lit(l) => (*l).to_string(),
            PathSeg::Token => token.to_string(),
        })
        .collect()
}

/// FR-39: resolve `<root>/<rel>` and prove it lives under `root` AFTER symlink
/// resolution. A file that does not exist yet is legal — the deepest existing
/// ancestor is what gets resolved and checked, so a stream can wait for a log
/// that is about to be created without ever escaping the root.
///
/// When `candidate` itself already exists, the returned path is the fully
/// CANONICALIZED one (every symlink resolved), not the raw join — so a caller
/// that opens exactly this path never re-traverses an unvalidated symlink
/// component. When it does not exist yet, only the deepest existing ancestor
/// could be validated, so the caller MUST re-run this check before every open
/// (see `follow_file`) rather than trusting the once-checked candidate —
/// otherwise a symlink planted after this call, between the ancestor and the
/// file, would be a TOCTOU escape.
pub(crate) fn resolve_under_root(root: &Path, rel: &str) -> Result<PathBuf, SourceError> {
    let root = std::fs::canonicalize(root).map_err(|_| SourceError::RootMissing)?;
    let candidate = root.join(rel);
    let mut probe = candidate.clone();
    let mut fully_existed = true;
    let resolved = loop {
        if let Ok(canonical) = std::fs::canonicalize(&probe) {
            break canonical;
        }
        fully_existed = false;
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => return Err(SourceError::OutsideRoot),
        }
    };
    if !resolved.starts_with(&root) {
        return Err(SourceError::OutsideRoot);
    }
    // The candidate existed in full, so `resolved` IS its canonical form — return
    // that instead of the raw join. When it did not, only the deepest existing
    // ancestor was validated, and the caller must re-check on every open.
    if fully_existed {
        Ok(resolved)
    } else {
        Ok(candidate)
    }
}

// ---------- the registry of live streams ----------

/// One live stream. `stop` is what every kill path sets; `child` is present only
/// for a `process` source. NO other identity is kept — a stream is its id.
pub(crate) struct Live {
    pub panel_id: String,
    pub extension_id: String,
    stop: Arc<AtomicBool>,
    child: Option<Arc<Mutex<Child>>>,
}

impl Live {
    fn kill(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.as_ref() {
            if let Ok(mut child) = child.lock() {
                kill_group(&mut child);
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Streams {
    by_id: HashMap<String, Live>,
    /// FR-42: one live stream per panel.
    by_panel: HashMap<String, String>,
}

impl Streams {
    /// Register a new stream for `panel_id`, closing any stream that panel
    /// already had (FR-42 — a different target is the same operation).
    pub(crate) fn open(
        &mut self,
        stream_id: &str,
        panel_id: &str,
        extension_id: &str,
        stop: Arc<AtomicBool>,
        child: Option<Arc<Mutex<Child>>>,
    ) {
        self.close_panel(panel_id);
        self.by_id.insert(
            stream_id.to_string(),
            Live {
                panel_id: panel_id.to_string(),
                extension_id: extension_id.to_string(),
                stop,
                child,
            },
        );
        self.by_panel
            .insert(panel_id.to_string(), stream_id.to_string());
    }

    /// `false` ⇒ `EXT_STREAM_NOT_FOUND` (unknown or already ended).
    pub(crate) fn close(&mut self, stream_id: &str) -> bool {
        let Some(live) = self.by_id.remove(stream_id) else {
            return false;
        };
        live.kill();
        if self.by_panel.get(&live.panel_id).map(String::as_str) == Some(stream_id) {
            self.by_panel.remove(&live.panel_id);
        }
        true
    }

    pub(crate) fn close_panel(&mut self, panel_id: &str) -> Option<String> {
        let stream_id = self.by_panel.get(panel_id).cloned()?;
        self.close(&stream_id);
        Some(stream_id)
    }

    /// FR-8: disabling an extension kills every stream it owns, in the same turn
    /// as the toggle write.
    pub(crate) fn close_extension(&mut self, extension_id: &str) -> Vec<String> {
        let ids: Vec<String> = self
            .by_id
            .iter()
            .filter(|(_, live)| live.extension_id == extension_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids.iter() {
            self.close(id);
        }
        ids
    }

    /// Every live stream, at app exit — a `docker logs -f` outliving Francois
    /// is exactly the orphan this feature promises never to leave behind.
    pub(crate) fn close_all(&mut self) {
        let ids: Vec<String> = self.by_id.keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    #[cfg(test)]
    pub(crate) fn is_live(&self, stream_id: &str) -> bool {
        self.by_id.contains_key(stream_id)
    }

    #[cfg(test)]
    pub(crate) fn stream_of_panel(&self, panel_id: &str) -> Option<&str> {
        self.by_panel.get(panel_id).map(String::as_str)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.by_id.len()
    }
}

// ---------- FR-40: the initial file read ----------

/// The last `max` lines of what a file already holds, sanitized (FR-51). The
/// core never forwards a whole 4 GB log because a user clicked a row: what is
/// already on disk is bounded here, and what arrives afterwards is bounded by
/// the frontend's ring.
pub(crate) fn last_lines(content: &str, max: usize) -> Vec<String> {
    let all: Vec<&str> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    // A trailing newline produces a final empty element that is not a line.
    let all = match all.last() {
        Some(last) if last.is_empty() => &all[..all.len() - 1],
        _ => &all[..],
    };
    let start = all.len().saturating_sub(max);
    all[start..].iter().map(|l| sanitize_line(l)).collect()
}

// ---------- starting a stream ----------

pub(crate) fn new_stream_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Emit one chunk, unless the stream has already been killed. Every emit goes
/// through here so a racing kill cannot append to a dead stream's buffer — the
/// frontend's `streamId` check (FR-44) is the second net, not the only one.
fn emit_chunk(app: &AppHandle, stream_id: &str, stop: &AtomicBool, lines: Vec<String>) {
    if lines.is_empty() || stop.load(Ordering::SeqCst) {
        return;
    }
    emit(
        app,
        ExtensionEvent::StreamChunk {
            stream_id: stream_id.to_string(),
            lines,
        },
    );
}

fn emit_ended(app: &AppHandle, stream_id: &str, stop: &AtomicBool, exit_code: Option<i32>) {
    if stop.load(Ordering::SeqCst) {
        return;
    }
    emit(
        app,
        ExtensionEvent::StreamEnded {
            stream_id: stream_id.to_string(),
            exit_code,
        },
    );
}

/// FR-38 `file` source: emit what the file already holds (bounded by FR-40),
/// then follow appends until the stream is killed. A truncated or rotated file
/// restarts from its new beginning rather than emitting garbage offsets.
///
/// FR-39: `root`/`rel` — not a pre-resolved `PathBuf` — because containment is
/// RE-VALIDATED on every poll via `resolve_under_root`, not just once at open
/// time. A pre-resolved path handed to a long-lived poll loop would be a TOCTOU
/// window: nothing stops a symlink from being planted at an unvalidated
/// ancestor between the initial check and a later `File::open`. Re-resolving
/// each iteration means every open goes through the same containment proof.
fn follow_file(
    app: AppHandle,
    stream_id: String,
    root: PathBuf,
    rel: String,
    stop: Arc<AtomicBool>,
) {
    let mut position: u64 = 0;
    let mut primed = false;
    // The `streamId` reaches the frontend as this call's RESOLVED value, so a
    // chunk emitted before that would be dropped by FR-44's ownership check.
    // A short beat first costs nothing and keeps the first screen of the log.
    std::thread::sleep(std::time::Duration::from_millis(150));
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let opened = resolve_under_root(&root, &rel)
            .and_then(|path| std::fs::File::open(&path).map_err(|_| SourceError::OutsideRoot));
        match opened {
            Ok(mut file) => {
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                if len < position {
                    position = 0; // truncated or rotated
                }
                if !primed {
                    let mut content = String::new();
                    let _ = file.read_to_string(&mut content);
                    emit_chunk(
                        &app,
                        &stream_id,
                        &stop,
                        last_lines(&content, EXT_LOG_MAX_LINES),
                    );
                    position = len;
                    primed = true;
                } else if len > position {
                    if file.seek(SeekFrom::Start(position)).is_ok() {
                        let mut content = String::new();
                        let _ = file.read_to_string(&mut content);
                        emit_chunk(
                            &app,
                            &stream_id,
                            &stop,
                            last_lines(&content, EXT_LOG_MAX_LINES),
                        );
                    }
                    position = len;
                }
            }
            // The file may not exist yet (a loop that has not started writing).
            // That is not an error — FR-38's empty state, waiting.
            Err(_) => primed = false,
        }
        std::thread::sleep(std::time::Duration::from_millis(FILE_POLL_MS));
    }
}

/// Start a `file` source. The initial containment check (FR-39) has already
/// run — `root`/`rel` (not the resolved path) are what the poll loop re-checks
/// on every iteration.
pub(crate) fn spawn_file_stream(
    app: &AppHandle,
    stream_id: &str,
    root: PathBuf,
    rel: String,
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    let id = stream_id.to_string();
    let flag = stop.clone();
    std::thread::spawn(move || follow_file(handle, id, root, rel, flag));
    stop
}

/// FR-38 `process` source argv: `argv0` plus the declared args with the single
/// token filled in. The token is passed after `--` where the definition says so,
/// and has already passed `valid_token`.
pub(crate) fn process_argv(source: &Source, token: Option<&str>) -> Option<Vec<String>> {
    let Source::Process { argv0, args } = source else {
        return None;
    };
    let mut argv = vec![(*argv0).to_string()];
    argv.extend(render_args(args, 0, 0, token));
    Some(argv)
}

fn pump_lines(app: AppHandle, stream_id: String, reader: impl Read, stop: Arc<AtomicBool>) {
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let text = line.strip_suffix('\n').unwrap_or(&line);
                let text = text.strip_suffix('\r').unwrap_or(text);
                emit_chunk(&app, &stream_id, &stop, vec![sanitize_line(text)]);
            }
        }
    }
}

/// Start a `process` source under the same env/cwd/stdin discipline as a
/// provider call (FR-20). It is EXEMPT from the FR-21 timeout by design — a
/// follow is supposed to run — and is bounded by the kill paths instead.
pub(crate) fn spawn_process_stream(
    app: &AppHandle,
    stream_id: &str,
    argv: &[String],
    cwd: &Path,
) -> Result<(Arc<AtomicBool>, Arc<Mutex<Child>>), std::io::Error> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env_clear();
    for (k, v) in scrub_env(std::env::vars()) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    // FR-43: the same discipline as a provider call — the child is put in its
    // own process group at spawn, so `Live::kill()`'s `killpg` actually reaches
    // any grandchild it forked instead of only ever killing the bare PID.
    own_process_group(&mut cmd);
    let mut child = cmd.spawn()?;

    let stop = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    if let Some(reader) = stdout {
        let (app, id, flag) = (app.clone(), stream_id.to_string(), stop.clone());
        std::thread::spawn(move || pump_lines(app, id, reader, flag));
    }
    // `docker logs` writes the container's stderr to OUR stderr — dropping it
    // would silently hide half of what the user asked to watch.
    if let Some(reader) = stderr {
        let (app, id, flag) = (app.clone(), stream_id.to_string(), stop.clone());
        std::thread::spawn(move || pump_lines(app, id, reader, flag));
    }

    {
        let (app, id, flag, waited) = (
            app.clone(),
            stream_id.to_string(),
            stop.clone(),
            child.clone(),
        );
        std::thread::spawn(move || {
            // FR-45: a process source that exits reports its code; the frontend
            // renders the error BELOW the retained buffer rather than replacing it.
            let code = loop {
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                let status = waited
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten());
                if let Some(status) = status {
                    break status.code();
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            };
            // Give the readers a moment to drain what the child already wrote.
            std::thread::sleep(std::time::Duration::from_millis(120));
            emit_ended(&app, &id, &flag, code);
        });
    }

    Ok((stop, child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::registry;
    use crate::extensions::testutil::tmp_root;

    // FR-38: the charset rule, re-validated in the core. A leading `-` is
    // structurally impossible, which is the point of the first class.
    #[test]
    fn the_token_rule_rejects_a_leading_dash_and_every_path_character() {
        assert!(valid_token("extensions"));
        assert!(valid_token("a"));
        assert!(valid_token("web-1.log_2"));
        assert!(valid_token("0abc"));

        assert!(!valid_token(""));
        assert!(!valid_token("-rf"));
        assert!(!valid_token("--upload-pack=evil"));
        assert!(!valid_token(".hidden"));
        assert!(!valid_token("../../etc/passwd"));
        assert!(!valid_token("a/b"));
        assert!(!valid_token("a\\b"));
        assert!(!valid_token("a b"));
        assert!(!valid_token("a;rm -rf /"));
        assert!(!valid_token("a$(id)"));
        assert!(!valid_token("é"));
        assert!(!valid_token(&"a".repeat(129)));
        assert!(valid_token(&"a".repeat(128)));
    }

    // FR-38: the declared path, with the one slot filled in.
    #[test]
    fn a_file_source_path_fills_its_single_slot() {
        let (_, panel) = registry::panel("cohorte:loop-log").unwrap();
        let Some(Source::File(segs)) = panel.source.as_ref() else {
            panic!("cohorte:loop-log must declare a file source");
        };
        assert_eq!(
            file_rel_path(segs, "extensions"),
            "specs/reports/extensions.loop.log"
        );
    }

    // FR-39: it keeps `specs/reports/<id>.loop.log` …
    #[test]
    fn a_file_source_resolves_inside_its_declared_root() {
        let root = tmp_root("stream-inside");
        std::fs::create_dir_all(root.join("specs/reports")).unwrap();
        std::fs::write(root.join("specs/reports/extensions.loop.log"), b"line\n").unwrap();
        let path = resolve_under_root(&root, "specs/reports/extensions.loop.log").unwrap();
        assert!(path.ends_with("specs/reports/extensions.loop.log"));
        // A file that does not exist YET is legal — the stream waits for it.
        assert!(resolve_under_root(&root, "specs/reports/later.loop.log").is_ok());
    }

    // A root that has simply vanished (deleted/unmounted project dir) is a
    // different failure than a genuine containment breach — it must not be
    // reported as `OutsideRoot`, so a caller can surface a distinct message.
    #[test]
    fn a_missing_root_is_reported_distinctly_from_an_escape() {
        let root = tmp_root("stream-root-missing");
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            resolve_under_root(&root, "specs/reports/extensions.loop.log"),
            Err(SourceError::RootMissing)
        );
    }

    // … and refuses `~/.ssh/id_rsa`, symlinks included, opening no handle.
    #[test]
    fn a_file_source_cannot_escape_its_declared_root() {
        let root = tmp_root("stream-escape");
        std::fs::create_dir_all(root.join("specs/reports")).unwrap();
        assert_eq!(
            resolve_under_root(&root, "../../etc/passwd"),
            Err(SourceError::OutsideRoot)
        );
        assert_eq!(
            resolve_under_root(&root, "specs/reports/../../../etc/passwd"),
            Err(SourceError::OutsideRoot)
        );

        #[cfg(unix)]
        {
            let outside = tmp_root("stream-outside");
            std::fs::write(outside.join("secret"), b"sshhh").unwrap();
            std::os::unix::fs::symlink(outside.join("secret"), root.join("specs/reports/link"))
                .unwrap();
            assert_eq!(
                resolve_under_root(&root, "specs/reports/link"),
                Err(SourceError::OutsideRoot)
            );
        }
    }

    // FR-38: the token lands after `--`, so it cannot be read as a flag.
    #[test]
    fn a_process_source_passes_its_token_after_the_double_dash() {
        let (_, panel) = registry::panel("docker:logs").unwrap();
        let argv = process_argv(panel.source.as_ref().unwrap(), Some("abc123")).unwrap();
        assert_eq!(
            argv,
            vec!["docker", "logs", "-f", "--tail", "200", "--", "abc123"]
        );
        assert_eq!(argv.iter().position(|a| a == "--").unwrap(), argv.len() - 2);
    }

    // FR-40: what is already on disk is bounded in the CORE.
    #[test]
    fn the_initial_file_read_is_bounded_and_sanitized() {
        let content: String = (0..3_000).map(|i| format!("line {i}\n")).collect();
        let lines = last_lines(&content, EXT_LOG_MAX_LINES);
        assert_eq!(lines.len(), EXT_LOG_MAX_LINES);
        assert_eq!(lines[0], "line 1000");
        assert_eq!(lines[EXT_LOG_MAX_LINES - 1], "line 2999");
        assert_eq!(last_lines("", 10), Vec::<String>::new());
        assert_eq!(last_lines("only\n", 10), vec!["only"]);
        assert_eq!(last_lines("\u{1b}[31mred\u{1b}[0m\n", 10), vec!["red"]);
    }

    fn flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    // FR-42: one live stream per panel — a second open closes the first, and a
    // different TARGET is the same operation.
    #[test]
    fn opening_a_second_stream_for_a_panel_closes_the_first() {
        let mut streams = Streams::default();
        let first_stop = flag();
        streams.open("s1", "docker:logs", "docker", first_stop.clone(), None);
        assert!(streams.is_live("s1"));

        let second_stop = flag();
        streams.open("s2", "docker:logs", "docker", second_stop.clone(), None);
        assert!(!streams.is_live("s1"), "the first stream must be closed");
        assert!(
            first_stop.load(Ordering::SeqCst),
            "the first must be killed"
        );
        assert!(streams.is_live("s2"));
        assert!(!second_stop.load(Ordering::SeqCst));
        assert_eq!(streams.stream_of_panel("docker:logs"), Some("s2"));
        assert_eq!(streams.len(), 1);
    }

    // Closing is by id, and closing an unknown id is EXT_STREAM_NOT_FOUND.
    #[test]
    fn closing_a_stream_kills_it_once() {
        let mut streams = Streams::default();
        let stop = flag();
        streams.open("s1", "cohorte:loop-log", "cohorte", stop.clone(), None);
        assert!(streams.close("s1"));
        assert!(stop.load(Ordering::SeqCst));
        assert!(!streams.close("s1"), "a closed stream is not found again");
        assert!(!streams.close("never-existed"));
        assert_eq!(streams.stream_of_panel("cohorte:loop-log"), None);
    }

    // FR-8: disabling an extension kills every stream IT owns, and nobody
    // else's.
    #[test]
    fn disabling_an_extension_kills_only_its_own_streams() {
        let mut streams = Streams::default();
        let docker_stop = flag();
        let cohorte_stop = flag();
        streams.open("s1", "docker:logs", "docker", docker_stop.clone(), None);
        streams.open(
            "s2",
            "cohorte:loop-log",
            "cohorte",
            cohorte_stop.clone(),
            None,
        );
        let killed = streams.close_extension("docker");
        assert_eq!(killed, vec!["s1".to_string()]);
        assert!(docker_stop.load(Ordering::SeqCst));
        assert!(!cohorte_stop.load(Ordering::SeqCst));
        assert!(streams.is_live("s2"));
    }

    // FR-44: the id is core-minted and unique per stream.
    #[test]
    fn stream_ids_are_minted_by_the_core_and_unique() {
        let a = new_stream_id();
        let b = new_stream_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
    }
}

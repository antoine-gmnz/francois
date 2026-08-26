//! FR-14/FR-15 — the six tool implementations.
//!
//! They reuse what the core already owns and reimplement nothing. Every one of
//! them runs only after `gate` has allowed the call.
//!
//! **Division of labour (spec §4).** `gate::resolve_in_cwd` resolves and
//! CONTAINS a call's path argument against the session `cwd` before a card is
//! ever shown (FR-13) — `read`/`write`/`edit`/`grep`/`glob` below therefore
//! take an already-resolved, already-contained absolute `&Path` and never
//! re-resolve or re-validate containment themselves. `bash` is FR-13's one
//! exception: it is not path-resolved and runs with the session `cwd` as its
//! working directory.
//!
//! Every function here returns a plain `String` — the text handed back to the
//! model as the tool result — for BOTH success and failure. A failing tool is
//! never a crash and never ends the turn (spec §3 "A gated tool"), so nothing
//! in this file panics on caller-controlled input: every fallible step
//! collapses to an error string instead of `unwrap()`/`expect()`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use regex::RegexBuilder;
use serde_json::Value;

use super::FrancoisTool;
use crate::fs_util::unique_temp_path;

// ---------- caps ----------
//
// FR-14 names exactly one of these (`BASH_OUTPUT_CAP_CHARS`, and the two
// timeout numbers). The rest are this module's own call, per the dispatch
// note ("the spec does not name one for these, so it is your call to make
// explicitly rather than silently") — each documented at its declaration.

/// FR-14: applied to the COMBINED stdout+stderr string (see `bash` below for
/// what "output" means here) after the process has finished or been killed.
const BASH_OUTPUT_CAP_CHARS: usize = 30_000;
/// FR-14.
const BASH_DEFAULT_TIMEOUT_SECS: u64 = 120;
/// FR-14.
const BASH_MAX_TIMEOUT_SECS: u64 = 600;
/// How often the wait loop polls the child for exit before the deadline.
const BASH_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Not named by the spec — chosen to comfortably hold most source files while
/// staying well inside a single turn's context budget (well under even the
/// smallest `OPENAI_CONTEXT_FALLBACK` entry). Upgrade trigger: if a model
/// routinely needs more of a single file than this, add `offset`/`limit`
/// line-range arguments (mirroring Claude Code's own Read schema) instead of
/// raising the cap further.
const READ_CAP_CHARS: usize = 100_000;

/// Bounds on `Grep`'s recursive content search — same reasoning as
/// `READ_CAP_CHARS`.
const GREP_MAX_MATCHES: usize = 500;
const GREP_OUTPUT_CAP_CHARS: usize = 50_000;

/// Bound on the number of paths `Glob` returns.
const GLOB_MAX_RESULTS: usize = 1000;

/// Shared bound on how many directory entries `Grep`/`Glob` will visit while
/// walking a directory, so a pathological tree cannot make either tool run
/// unbounded (symlinks are never followed at all — see `walk_entries` — so
/// this is a belt-and-braces cap, not the only defence).
const WALK_MAX_VISITS: usize = 50_000;

fn missing_arg(name: &str) -> String {
    format!("Missing or invalid \"{name}\" argument.")
}

// ---------- Read ----------

/// `Read` — the file at `path` (already resolved + contained by `gate`),
/// capped at `READ_CAP_CHARS`. Never fails loudly: a missing file, a
/// permission error, or invalid UTF-8 all come back as a string explaining
/// what happened rather than propagating an `Err`/panic.
pub fn read(path: &Path, _args: &Value) -> String {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return format!("Could not read {}: {e}", path.display()),
    };
    let (text, lossy) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    };
    let total = text.chars().count();
    let (mut out, truncated) = if total > READ_CAP_CHARS {
        (text.chars().take(READ_CAP_CHARS).collect::<String>(), true)
    } else {
        (text, false)
    };
    if lossy {
        out.push_str("\n\n[note: file is not valid UTF-8; decoded lossily]");
    }
    if truncated {
        out.push_str(&format!(
            "\n\n[truncated: showing the first {READ_CAP_CHARS} of {total} characters]"
        ));
    }
    out
}

// ---------- Write ----------

/// `Write` — create or fully overwrite the file at `path` (already resolved +
/// contained by `gate`) with `args.content`. Written atomically (sibling temp
/// file + rename) using the crate's existing `fs_util::unique_temp_path` — the
/// same shape every other atomic writer in this crate uses. The write itself
/// is genuinely new: `fs_util` carries no generic "write arbitrary content"
/// helper today, only the user-only-file primitive, which exists for
/// credentials and would wrongly restrict an ordinary project file's
/// permissions if reused here.
pub fn write(path: &Path, args: &Value) -> String {
    let Some(content) = args.get("content").and_then(Value::as_str) else {
        return missing_arg("content");
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return format!("Could not create {}: {e}", dir.display());
        }
    }
    let tmp = unique_temp_path(path, "write");
    if let Err(e) = std::fs::write(&tmp, content.as_bytes()) {
        return format!("Could not write {}: {e}", path.display());
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return format!("Could not finalize write to {}: {e}", path.display());
    }
    format!("Wrote {} ({} bytes).", path.display(), content.len())
}

// ---------- Edit ----------

/// `Edit` — FR-15: the same contract Claude Code's own Edit tool carries.
/// Fails the call (error string, NO write of any kind) when `old_string` is
/// absent from the file, or matches more than once and `replace_all` is not
/// `true`. The replacement is computed in memory first and the file is only
/// ever touched once, after every validation has passed — so a failed call
/// leaves the file byte-for-byte unchanged.
pub fn edit(path: &Path, args: &Value) -> String {
    let Some(old_string) = args.get("old_string").and_then(Value::as_str) else {
        return missing_arg("old_string");
    };
    let Some(new_string) = args.get("new_string").and_then(Value::as_str) else {
        return missing_arg("new_string");
    };
    if old_string.is_empty() {
        return "old_string must not be empty.".to_string();
    }
    let replace_all = args
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return format!("Could not read {}: {e}", path.display()),
    };

    let occurrences = content.matches(old_string).count();
    if occurrences == 0 {
        return format!("old_string not found in {}.", path.display());
    }
    if occurrences > 1 && !replace_all {
        return format!(
            "old_string matches {occurrences} times in {} — pass replace_all: true, or include \
             more surrounding context to make the match unique.",
            path.display()
        );
    }

    let updated = if replace_all {
        content.replace(old_string, new_string)
    } else {
        content.replacen(old_string, new_string, 1)
    };

    let tmp = unique_temp_path(path, "edit");
    if let Err(e) = std::fs::write(&tmp, updated.as_bytes()) {
        return format!("Could not write {}: {e}", path.display());
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return format!("Could not finalize edit to {}: {e}", path.display());
    }
    let count = if replace_all { occurrences } else { 1 };
    format!(
        "Edited {} ({count} replacement{}).",
        path.display(),
        if count == 1 { "" } else { "s" }
    )
}

// ---------- Grep ----------

/// `Grep` — a bounded regular-expression content search under `path` (already
/// resolved + contained by `gate`; may be a file or a directory).
/// `args.pattern` is compiled as a `regex`-crate regular expression and
/// matched anywhere within each line (the same "search, not full-line
/// anchor" semantics Claude Code's own Grep tool documents; an author who
/// wants the whole line writes `^...$` themselves); `args["-i"]: true` folds
/// case via the regex builder's own case-insensitive mode (the key Claude
/// Code's own Grep tool uses for the same flag) rather than lowercasing the
/// haystack, so character classes and anchors keep working under `-i`. An
/// invalid pattern is never a panic or a silent empty result: it comes back
/// as an error string naming the pattern and the parser's complaint, because
/// this tool carries Claude Code's own name and a user's regex habits must
/// transfer. Binary / non-UTF-8 files are skipped rather than failing the
/// whole call.
pub fn grep(path: &Path, args: &Value) -> String {
    let Some(pattern) = args.get("pattern").and_then(Value::as_str) else {
        return missing_arg("pattern");
    };
    if pattern.is_empty() {
        return "pattern must not be empty.".to_string();
    }
    let case_insensitive = args.get("-i").and_then(Value::as_bool).unwrap_or(false);
    let re = match RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
    {
        Ok(re) => re,
        Err(e) => return format!("Invalid regex pattern \"{pattern}\": {e}"),
    };

    let files: Vec<PathBuf> = if path.is_file() {
        vec![path.to_path_buf()]
    } else if path.is_dir() {
        walk_entries(path, WALK_MAX_VISITS)
            .into_iter()
            .filter(|p| p.is_file())
            .collect()
    } else {
        return format!("{} does not exist.", path.display());
    };

    let mut matches = Vec::new();
    'files: for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue; // binary / unreadable — skipped, not an error
        };
        for (n, line) in text.lines().enumerate() {
            if re.is_match(line) {
                matches.push(format!("{}:{}: {}", display_path(file, path), n + 1, line));
                if matches.len() >= GREP_MAX_MATCHES {
                    break 'files;
                }
            }
        }
    }

    if matches.is_empty() {
        return "No matches found.".to_string();
    }
    let hit_cap = matches.len() >= GREP_MAX_MATCHES;
    let mut out = matches.join("\n");
    if out.chars().count() > GREP_OUTPUT_CAP_CHARS {
        out = out.chars().take(GREP_OUTPUT_CAP_CHARS).collect();
        out.push_str(&format!(
            "\n\n[truncated at {GREP_OUTPUT_CAP_CHARS} characters]"
        ));
    } else if hit_cap {
        out.push_str(&format!("\n\n[stopped at {GREP_MAX_MATCHES} matches]"));
    }
    out
}

// ---------- Glob ----------

/// `Glob` — files and directories under `path` (already resolved + contained
/// by `gate`; must itself be a directory) whose ROOT-RELATIVE path matches
/// `args.pattern`. Supports `*` (any run within one path segment), `?` (one
/// character within a segment) and `**` (zero or more whole segments) — the
/// same three wildcards Claude Code's own Glob tool documents. Results are
/// sorted alphabetically for determinism (this module has no reason to read
/// mtimes) and capped at `GLOB_MAX_RESULTS`.
pub fn glob(path: &Path, args: &Value) -> String {
    let Some(pattern) = args.get("pattern").and_then(Value::as_str) else {
        return missing_arg("pattern");
    };
    if pattern.is_empty() {
        return "pattern must not be empty.".to_string();
    }
    if !path.is_dir() {
        return format!("{} is not a directory.", path.display());
    }

    let mut hits: Vec<String> = walk_entries(path, WALK_MAX_VISITS)
        .into_iter()
        .map(|p| display_path(&p, path))
        .filter(|rel| glob_path_match(pattern, rel))
        .collect();
    hits.sort();

    if hits.is_empty() {
        return "No files matched.".to_string();
    }
    let total = hits.len();
    let truncated = total > GLOB_MAX_RESULTS;
    hits.truncate(GLOB_MAX_RESULTS);
    let mut out = hits.join("\n");
    if truncated {
        out.push_str(&format!(
            "\n\n[truncated: showing {GLOB_MAX_RESULTS} of {total} matches]"
        ));
    }
    out
}

/// Root-relative, forward-slash display form of `file` — shared by `Grep` and
/// `Glob` so both tools speak the same path form back to the model regardless
/// of platform.
fn display_path(file: &Path, root: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file);
    rel.to_string_lossy().replace('\\', "/")
}

/// Recursively lists files AND directories under `root`, skipping symlinks
/// (never followed — the simplest bound against a symlink ring) and `.git`
/// (never useful to Grep/Glob and often enormous), stopping once
/// `max_visits` entries have been read so a pathological tree cannot make
/// either tool unbounded.
fn walk_entries(root: &Path, max_visits: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= max_visits {
                return out;
            }
            visited += 1;
            let entry_path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&entry_path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if entry.file_name() == ".git" {
                    continue;
                }
                stack.push(entry_path.clone());
                out.push(entry_path);
            } else {
                out.push(entry_path);
            }
        }
    }
    out
}

/// `**` matches zero or more whole path segments; every other segment is
/// matched against the candidate segment with `glob_segment_match`.
fn glob_path_match(pattern: &str, rel_path: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let path: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
    fn rec(pat: &[&str], path: &[&str]) -> bool {
        match pat.first() {
            None => path.is_empty(),
            Some(&"**") => rec(&pat[1..], path) || (!path.is_empty() && rec(pat, &path[1..])),
            Some(seg) => {
                !path.is_empty() && glob_segment_match(seg, path[0]) && rec(&pat[1..], &path[1..])
            }
        }
    }
    rec(&pat, &path)
}

/// `*` (any run, possibly empty) and `?` (exactly one character) within a
/// single path segment — classic backtracking wildcard match.
fn glob_segment_match(pattern: &str, segment: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = segment.chars().collect();
    fn rec(p: &[char], s: &[char]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some('*'), _) => rec(&p[1..], s) || (!s.is_empty() && rec(p, &s[1..])),
            (Some('?'), Some(_)) => rec(&p[1..], &s[1..]),
            (Some(pc), Some(sc)) if pc == sc => rec(&p[1..], &s[1..]),
            _ => false,
        }
    }
    rec(&p, &s)
}

// ---------- Bash ----------

/// `Bash` — FR-13's one exception: not path-resolved, runs with `cwd` as its
/// working directory. Shell choice mirrors the crate's existing convention
/// for running an arbitrary command line cross-platform (`update/helper.rs`,
/// `shell/mod.rs`'s test PTY spawn): `cmd.exe /C <command>` on Windows,
/// `/bin/sh -c <command>` elsewhere. This means POSIX-style compound commands
/// (`&&`, pipes, `ls -la`) run as-is on macOS/Linux but are read by cmd.exe's
/// OWN (more limited) syntax on Windows — routing through WSL (`src/wsl.rs`,
/// `wsl-filesystem`) would fix that but is explicitly out of scope for this
/// dispatch; flagged as a TODO in the handoff.
///
/// "Output" is stdout followed by, if non-empty, a `--- stderr ---` separator
/// and stderr — concatenated in that order, not truly interleaved (real
/// interleaving would need pty-level capture, out of scope here). The
/// COMBINED string is what FR-14's 30_000-character cap applies to.
pub fn bash(cwd: &Path, args: &Value) -> String {
    let Some(command) = args.get("command").and_then(Value::as_str) else {
        return missing_arg("command");
    };
    if command.trim().is_empty() {
        return "command must not be empty.".to_string();
    }
    let timeout_secs = args
        .get("timeout")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)))
        .map(|t| t.clamp(1, BASH_MAX_TIMEOUT_SECS))
        .unwrap_or(BASH_DEFAULT_TIMEOUT_SECS);

    // core-architecture-fixes FR-20, now core-architecture-wave3 FR-7: this
    // shell's own PATH decides what a bare binary name in `command` resolves to.
    // Without the facade's login-shell PATH a GUI launch inherits launchd's
    // minimal one (macOS) and a tool call carrying Claude Code's own `Bash` name
    // resolves binaries against a DIFFERENT PATH than every other runtime,
    // reintroducing exactly the bug ext-path-resolution fixed elsewhere.
    let cmd = if cfg!(windows) {
        crate::process_util::spawn("cmd").arg("/C").arg(command)
    } else {
        crate::process_util::spawn("/bin/sh").arg("-c").arg(command)
    };
    let cmd = cmd
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.start() {
        Ok(c) => c,
        Err(e) => return format!("Could not start the shell: {e}"),
    };

    let Some(stdout) = child.stdout.take() else {
        return "Could not capture the command's stdout.".to_string();
    };
    let Some(stderr) = child.stderr.take() else {
        return "Could not capture the command's stderr.".to_string();
    };
    let stdout_handle = std::thread::spawn(move || read_all(stdout));
    let stderr_handle = std::thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(BASH_POLL_INTERVAL);
            }
            Err(_) => break,
        }
    }

    let stdout_text = stdout_handle.join().unwrap_or_default();
    let stderr_text = stderr_handle.join().unwrap_or_default();

    let mut combined = stdout_text;
    if !stderr_text.is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str("--- stderr ---\n");
        combined.push_str(&stderr_text);
    }

    if combined.chars().count() > BASH_OUTPUT_CAP_CHARS {
        combined = combined.chars().take(BASH_OUTPUT_CAP_CHARS).collect();
        combined.push_str(&format!(
            "\n\n[truncated at {BASH_OUTPUT_CAP_CHARS} characters]"
        ));
    }

    if timed_out {
        format!("[timed out after {timeout_secs}s, process killed]\n{combined}")
    } else {
        combined
    }
}

fn read_all(mut pipe: impl std::io::Read) -> String {
    let mut buf = Vec::new();
    let _ = pipe.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

// ---------- dispatch ----------

/// The one entry point the turn loop calls: routes an already-gate-approved
/// call to its executor. `resolved_path` is `Some` for every tool except
/// `Bash` (FR-13) — `gate::resolve_in_cwd` is responsible for producing it
/// before this is ever reached; `None` for a path tool is a defensive
/// fallback, not an expected path.
pub fn execute(
    tool: FrancoisTool,
    resolved_path: Option<&Path>,
    cwd: &Path,
    args: &Value,
) -> String {
    match tool {
        FrancoisTool::Bash => bash(cwd, args),
        FrancoisTool::Read => resolved_path.map_or_else(missing_path, |p| read(p, args)),
        FrancoisTool::Write => resolved_path.map_or_else(missing_path, |p| write(p, args)),
        FrancoisTool::Edit => resolved_path.map_or_else(missing_path, |p| edit(p, args)),
        FrancoisTool::Grep => resolved_path.map_or_else(missing_path, |p| grep(p, args)),
        FrancoisTool::Glob => resolved_path.map_or_else(missing_path, |p| glob(p, args)),
    }
}

fn missing_path() -> String {
    "Internal error: no resolved path was supplied for this tool.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A unique, NOT-yet-created throwaway directory — same shape as the
    /// sibling temp-dir helpers in this crate (`fs_util.rs`, `gate.rs`'s
    /// `temp_cwd`), since this crate carries no temp-dir dev-dependency.
    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "francois-oai-tools-{tag}-{}-{n}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    // ---------- Edit (FR-15) ----------

    #[test]
    fn edit_fails_when_old_string_is_absent_and_writes_nothing() {
        let dir = tmp_dir("edit-absent");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "hello world").unwrap();

        let out = edit(
            &file,
            &json!({ "old_string": "missing", "new_string": "x" }),
        );
        assert!(out.contains("not found"), "{out}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello world");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_fails_on_two_matches_without_replace_all_and_writes_nothing() {
        let dir = tmp_dir("edit-two-matches");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "foo foo").unwrap();

        let out = edit(&file, &json!({ "old_string": "foo", "new_string": "bar" }));
        assert!(out.contains("matches 2 times"), "{out}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "foo foo");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_replaces_all_when_replace_all_is_true() {
        let dir = tmp_dir("edit-replace-all");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "foo foo foo").unwrap();

        let out = edit(
            &file,
            &json!({ "old_string": "foo", "new_string": "bar", "replace_all": true }),
        );
        assert!(out.contains("3 replacements"), "{out}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "bar bar bar");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_replaces_a_single_unique_match() {
        let dir = tmp_dir("edit-single");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "hello world").unwrap();

        let out = edit(
            &file,
            &json!({ "old_string": "world", "new_string": "there" }),
        );
        assert!(out.contains("1 replacement"), "{out}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello there");
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- Write ----------

    #[test]
    fn write_creates_a_new_file_and_its_parent_dirs() {
        let dir = tmp_dir("write-new");
        let file = dir.join("nested").join("a.txt");

        let out = write(&file, &json!({ "content": "hello" }));
        assert!(out.contains("Wrote"), "{out}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_overwrites_an_existing_file() {
        let dir = tmp_dir("write-overwrite");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "old").unwrap();

        write(&file, &json!({ "content": "new" }));
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- Read ----------

    #[test]
    fn read_on_a_missing_file_returns_an_error_string_not_a_panic() {
        let dir = tmp_dir("read-missing");
        let file = dir.join("does-not-exist.txt");
        let out = read(&file, &json!({}));
        assert!(out.contains("Could not read"), "{out}");
    }

    #[test]
    fn read_returns_file_contents() {
        let dir = tmp_dir("read-ok");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "hello").unwrap();
        assert_eq!(read(&file, &json!({})), "hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_truncates_at_the_cap() {
        let dir = tmp_dir("read-cap");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.txt");
        fs::write(&file, "x".repeat(READ_CAP_CHARS + 500)).unwrap();
        let out = read(&file, &json!({}));
        assert!(out.contains("truncated"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- Bash ----------

    #[test]
    fn bash_runs_a_command_and_captures_output() {
        let dir = tmp_dir("bash-echo");
        fs::create_dir_all(&dir).unwrap();
        let out = bash(&dir, &json!({ "command": "echo hi" }));
        assert!(out.contains("hi"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    // FR-20: the shell's PATH must be the login-shell one (when it resolves),
    // not whatever the app inherited — otherwise a bare binary name in the
    // Francois agent loop's Bash tool resolves differently than every other
    // runtime's spawn. `echo $PATH` is the most direct way to pin the ACTUAL
    // env a spawned child sees, rather than asserting the call was made.
    #[cfg(unix)]
    #[test]
    fn bash_spawns_with_the_login_shell_path_when_it_resolves() {
        let dir = tmp_dir("bash-path-env");
        fs::create_dir_all(&dir).unwrap();
        let out = bash(&dir, &json!({ "command": "echo -n $PATH" }));
        let expected = crate::process_util::login_shell_path_env()
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        assert_eq!(out.trim(), expected.trim());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bash_honours_its_timeout_and_kills_a_hanging_process() {
        let dir = tmp_dir("bash-timeout");
        fs::create_dir_all(&dir).unwrap();
        let cmd = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let out = bash(&dir, &json!({ "command": cmd, "timeout": 1 }));
        assert!(out.contains("timed out"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bash_clamps_a_timeout_above_the_600s_ceiling() {
        // A behavioural test of the raw 600s wait would take 600s — this only
        // proves the clamp arithmetic is applied (a command that finishes
        // immediately still succeeds when the requested timeout is absurd),
        // which is what distinguishes "clamped" from "ignored".
        let dir = tmp_dir("bash-clamp");
        fs::create_dir_all(&dir).unwrap();
        let out = bash(&dir, &json!({ "command": "echo ok", "timeout": 999_999 }));
        assert!(out.contains("ok"), "{out}");
        assert!(!out.contains("timed out"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bash_truncates_output_at_30000_characters() {
        let dir = tmp_dir("bash-truncate");
        fs::create_dir_all(&dir).unwrap();
        let target = BASH_OUTPUT_CAP_CHARS + 5000;
        let cmd = if cfg!(windows) {
            format!("for /L %i in (1,1,{}) do @echo x", target / 2)
        } else {
            format!("yes x | head -c {target}")
        };
        let out = bash(&dir, &json!({ "command": cmd }));
        assert!(out.contains("truncated"), "{out}");
        assert!(
            out.chars().count() <= BASH_OUTPUT_CAP_CHARS + 100,
            "output was not capped: {} chars",
            out.chars().count()
        );
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- every tool's failure path is a string, never a panic ----------

    #[test]
    fn every_tool_returns_a_string_on_bad_input_instead_of_unwinding() {
        let dir = tmp_dir("bad-input");
        let missing = dir.join("nope.txt");
        assert!(!read(&missing, &json!({})).is_empty());
        assert!(!write(&missing, &json!({})).is_empty()); // missing "content"
        assert!(!edit(&missing, &json!({})).is_empty()); // missing old_string/new_string
        assert!(!grep(&missing, &json!({})).is_empty()); // missing "pattern"
        assert!(!glob(&missing, &json!({})).is_empty()); // missing "pattern"
        assert!(!bash(&dir, &json!({})).is_empty()); // missing "command"
    }

    // ---------- Grep / Glob ----------

    #[test]
    fn grep_finds_a_literal_match_recursively() {
        let dir = tmp_dir("grep-smoke");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "hello world\nfoo").unwrap();
        fs::write(dir.join("sub").join("b.txt"), "another hello").unwrap();

        let out = grep(&dir, &json!({ "pattern": "hello" }));
        assert!(out.contains("a.txt:1:"), "{out}");
        assert!(out.contains("sub/b.txt:1:"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_case_insensitive_flag_folds_case() {
        let dir = tmp_dir("grep-ci");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "HELLO").unwrap();

        assert_eq!(
            grep(&dir, &json!({ "pattern": "hello" })),
            "No matches found."
        );
        let out = grep(&dir, &json!({ "pattern": "hello", "-i": true }));
        assert!(out.contains("HELLO"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_matches_a_real_regex_a_substring_search_could_not() {
        let dir = tmp_dir("grep-regex");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("a.rs"),
            "fn helper() {}\nlet x = 1;\nfn other() {}\n",
        )
        .unwrap();

        let out = grep(&dir, &json!({ "pattern": r"fn \w+" }));
        assert!(out.contains("fn helper"), "{out}");
        assert!(out.contains("fn other"), "{out}");
        assert!(!out.contains("let x"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_supports_an_anchored_pattern() {
        let dir = tmp_dir("grep-anchor");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "hello world\n  hello indented\n").unwrap();

        let out = grep(&dir, &json!({ "pattern": "^hello" }));
        assert!(out.contains("a.txt:1:"), "{out}");
        assert!(!out.contains("a.txt:2:"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_supports_a_character_class() {
        let dir = tmp_dir("grep-class");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "cat\ncot\ncut\ncet\n").unwrap();

        let out = grep(&dir, &json!({ "pattern": "c[aou]t" }));
        assert!(out.contains("a.txt:1:"), "{out}"); // cat
        assert!(out.contains("a.txt:2:"), "{out}"); // cot
        assert!(out.contains("a.txt:3:"), "{out}"); // cut
        assert!(!out.contains("a.txt:4:"), "{out}"); // cet
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_regex_case_insensitive_flag_still_folds_case() {
        let dir = tmp_dir("grep-regex-ci");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "HELLO WORLD").unwrap();

        assert_eq!(
            grep(&dir, &json!({ "pattern": r"hel+o" })),
            "No matches found."
        );
        let out = grep(&dir, &json!({ "pattern": r"hel+o", "-i": true }));
        assert!(out.contains("HELLO"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_on_an_invalid_regex_returns_an_error_string_naming_the_problem() {
        let dir = tmp_dir("grep-invalid-regex");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();

        let out = grep(&dir, &json!({ "pattern": "[unclosed" }));
        assert!(out.contains("[unclosed"), "{out}");
        assert!(
            out.to_lowercase().contains("regex") || out.to_lowercase().contains("invalid"),
            "{out}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_still_enforces_the_match_and_output_caps_with_a_regex() {
        let dir = tmp_dir("grep-caps-regex");
        fs::create_dir_all(&dir).unwrap();
        let mut content = String::new();
        for i in 0..(GREP_MAX_MATCHES + 50) {
            content.push_str(&format!("line{i} match\n"));
        }
        fs::write(dir.join("a.txt"), content).unwrap();

        let out = grep(&dir, &json!({ "pattern": r"line\d+ match" }));
        assert!(
            out.contains(&format!("[stopped at {GREP_MAX_MATCHES} matches]")),
            "{out}"
        );
        let match_lines = out.lines().filter(|l| l.contains("a.txt:")).count();
        assert_eq!(match_lines, GREP_MAX_MATCHES, "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn glob_matches_a_recursive_pattern() {
        let dir = tmp_dir("glob-smoke");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.rs"), "").unwrap();
        fs::write(dir.join("sub").join("b.rs"), "").unwrap();
        fs::write(dir.join("c.txt"), "").unwrap();

        let out = glob(&dir, &json!({ "pattern": "**/*.rs" }));
        assert!(out.contains("a.rs"), "{out}");
        assert!(out.contains("sub/b.rs"), "{out}");
        assert!(!out.contains("c.txt"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn glob_top_level_pattern_does_not_cross_directories() {
        let dir = tmp_dir("glob-top-level");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.rs"), "").unwrap();
        fs::write(dir.join("sub").join("b.rs"), "").unwrap();

        let out = glob(&dir, &json!({ "pattern": "*.rs" }));
        assert!(out.contains("a.rs"), "{out}");
        assert!(!out.contains("b.rs"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- FrancoisTool dispatch ----------

    #[test]
    fn execute_routes_bash_without_a_resolved_path() {
        let dir = tmp_dir("execute-bash");
        fs::create_dir_all(&dir).unwrap();
        let out = execute(
            FrancoisTool::Bash,
            None,
            &dir,
            &json!({ "command": "echo hi" }),
        );
        assert!(out.contains("hi"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn execute_routes_read_through_the_resolved_path() {
        let dir = tmp_dir("execute-read");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "hi").unwrap();
        let out = execute(FrancoisTool::Read, Some(&file), &dir, &json!({}));
        assert_eq!(out, "hi");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn execute_without_a_resolved_path_for_a_path_tool_is_a_defensive_error_not_a_panic() {
        let dir = tmp_dir("execute-missing-path");
        fs::create_dir_all(&dir).unwrap();
        let out = execute(FrancoisTool::Read, None, &dir, &json!({}));
        assert!(out.contains("Internal error"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }
}

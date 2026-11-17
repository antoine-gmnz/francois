//! claude-project-health — two `claude -p` preconditions Francois can check
//! before they bite a turn (contract/claude-project-health.ts).
//!
//! 1. **Folder trust, as `-p` reads it.** Claude Code ignores a project's
//!    `.claude/settings.json` `permissions.allow` rules until the folder is
//!    trusted, so every "allowed" command still asks for approval. VERIFIED
//!    against the shipped CLI (2.1.326, throwaway dirs) — trust these over the
//!    MCP module's model:
//!      - trusted iff `projects[<key>].hasTrustDialogAccepted === true` for
//!        EXACTLY the key — no ancestor walk (a trusted `~/src` does not trust
//!        `~/src/repo`), and trusting a non-root subdirectory does not count;
//!      - key = the git repository root of the cwd, or for a LINKED WORKTREE the
//!        MAIN repository root (parent of the common git dir), never the
//!        worktree path;
//!      - keys are absolute realpaths with forward slashes (macOS `/tmp` →
//!        `/private/tmp`);
//!      - allow rules (and hooks) are read from `<cwd>/.claude/settings.json` +
//!        `settings.local.json`, not from the git root.
//!    `mcp_approval::trust_accepted` / `cli_project_key` deliberately keep the
//!    ancestor-walking, worktree-keyed model — that is what the interactive
//!    Remote Control host checks — so this module has its own resolver and
//!    predicate and only shares the low-level helpers.
//!
//! 2. **Cohorte's fail-closed guard hook.** Cohorte registers a PreToolUse hook
//!    running `python3 …/cohorte-gate.py` with `onFailure: "block"`. When the
//!    interpreter is not on the PATH Francois hands `claude` (the login-shell
//!    PATH, `process_util`), EVERY covered tool call is refused with
//!    `/bin/sh: python3: command not found`. Detecting the registration and
//!    resolving the interpreter up front turns that into one banner.
//!
//! Every write here (`session_trust_folder`) is the direct result of a click.

use super::mcp_approval::{apply_decision, claude_json_path, git_root, node_trusted};
use super::{norm_path, AgentRuntime, Engine};
use crate::ipc::{err, ok, AppError, ErrorCode, IpcResult};
use crate::permissions::{local_settings_path, read_json_object, write_json_atomic};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

// ---------- contract shapes (contract/claude-project-health.ts) ----------

/// contract ClaudeTrustHealth.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTrustHealth {
    pub trusted: bool,
    pub key: String,
    pub allow_rule_count: u32,
}

/// contract ClaudeGuardHealth.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeGuardHealth {
    pub registered: bool,
    pub interpreter_missing: Option<String>,
}

/// contract ClaudeProjectHealth.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProjectHealth {
    pub trust: ClaudeTrustHealth,
    pub guard: ClaudeGuardHealth,
}

impl ClaudeProjectHealth {
    /// "Nothing to report" — what a non-Claude runtime answers.
    pub fn neutral() -> Self {
        Self {
            trust: ClaudeTrustHealth {
                trusted: true,
                key: String::new(),
                allow_rule_count: 0,
            },
            guard: ClaudeGuardHealth {
                registered: false,
                interpreter_missing: None,
            },
        }
    }
}

// ---------- the trust key ----------

/// `canonicalize`, minus Windows' verbatim prefix (`\\?\C:\…` → `C:\…`,
/// `\\?\UNC\srv\…` → `\\srv\…`), falling back to the input for a path that
/// does not exist or cannot be resolved.
fn realpath(p: &Path) -> PathBuf {
    let Ok(c) = std::fs::canonicalize(p) else {
        return p.to_path_buf();
    };
    let s = c.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    c
}

/// For a `.git` FILE (`gitdir: <dir>`), the main repository root when `<dir>`
/// is a linked worktree's admin dir — the parent of its common git dir. `None`
/// for anything else (a submodule's `.git` file points at `.git/modules/<n>`,
/// whose checkout IS its own root).
///
/// The common dir comes from `<gitdir>/commondir` (what git writes, usually
/// `../..`) and falls back to the `…/worktrees/<name>` shape when that file is
/// missing.
fn linked_worktree_main_root(dot_git_file: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(dot_git_file).ok()?;
    let raw = content
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))?
        .trim();
    if raw.is_empty() {
        return None;
    }
    let base = dot_git_file.parent()?;
    let gitdir = realpath(&base.join(raw));
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(c) if !c.trim().is_empty() => realpath(&gitdir.join(c.trim())),
        _ => {
            let parent = gitdir.parent()?;
            if parent.file_name()? != "worktrees" {
                return None;
            }
            parent.parent()?.to_path_buf()
        }
    };
    Some(common.parent()?.to_path_buf())
}

/// The root a `-p` run keys trust on, as a HOST path (before the WSL
/// translation): the realpath of the cwd's git root, the main root for a
/// linked worktree, the cwd itself outside a repo.
fn trust_root(cwd: &str) -> PathBuf {
    let cwd = realpath(Path::new(cwd));
    let Some(root) = git_root(&cwd.to_string_lossy()) else {
        return cwd;
    };
    let root = PathBuf::from(root);
    let dot_git = root.join(".git");
    if dot_git.is_file() {
        if let Some(main) = linked_worktree_main_root(&dot_git) {
            return realpath(&main);
        }
    }
    root
}

/// The exact `projects` key a `claude -p` run in `cwd` reads trust from.
///
/// A `wsl` session's cwd is a `\\wsl$\<distro>\…` UNC path on the host while
/// the CLI inside the distro sees the Linux path, so the key is translated.
/// (Unverified against a real WSL CLI; symlinks inside the distro are not
/// resolved by a host-side realpath.)
pub fn trust_key(cwd: &str, runtime: &str) -> String {
    let host = trust_root(cwd).to_string_lossy().to_string();
    if runtime == "wsl" {
        if let Some((_, linux)) = crate::wsl::wsl_unc_to_linux(&host) {
            return norm_path(&linux);
        }
    }
    norm_path(&host)
}

// ---------- the cwd's settings (pure readers) ----------

/// `<cwd>/.claude/settings.json` + `settings.local.json`, skipping missing or
/// unreadable files (a file Francois cannot parse must not fail the probe).
fn cwd_settings_docs(cwd: &str) -> Vec<Value> {
    [
        Path::new(cwd).join(".claude").join("settings.json"),
        local_settings_path(cwd),
    ]
    .iter()
    .filter_map(|p| read_json_object(p).ok())
    .collect()
}

/// Number of `permissions.allow` entries across the documents.
pub fn allow_rule_count(docs: &[Value]) -> u32 {
    docs.iter()
        .filter_map(|d| d.pointer("/permissions/allow").and_then(|a| a.as_array()))
        .map(|a| a.len() as u32)
        .sum()
}

const GUARD_SCRIPT: &str = "cohorte-gate.py";

/// One registered guard hook — `interpreter` is what has to resolve on PATH
/// for it to run (`None` when the script is invoked directly).
#[derive(Debug, PartialEq)]
pub struct GuardHook {
    pub interpreter: Option<String>,
}

/// The first token of a shell command, honouring one level of quoting.
fn first_shell_token(cmd: &str) -> Option<String> {
    let cmd = cmd.trim_start();
    if let Some(rest) = cmd.strip_prefix('"').or_else(|| cmd.strip_prefix('\'')) {
        let q = cmd.chars().next()?;
        return rest.split(q).next().map(str::to_string);
    }
    cmd.split_whitespace().next().map(str::to_string)
}

/// The interpreter a guard hook entry needs. Exec form (`command` + `args`) —
/// the command itself; shell form — its first token. `None` when the script is
/// the program, or the program is a shell variable this cannot resolve.
fn interpreter_of(command: &str, exec_form: bool) -> Option<String> {
    let program = if exec_form {
        Some(command.trim().to_string())
    } else {
        first_shell_token(command)
    }?;
    if program.is_empty() || program.contains(GUARD_SCRIPT) || program.starts_with('$') {
        return None;
    }
    Some(program)
}

/// Every PreToolUse hook whose command (or exec-form `args`) references
/// `cohorte-gate.py`, across the documents.
pub fn find_guards(docs: &[Value]) -> Vec<GuardHook> {
    let mut out = Vec::new();
    for doc in docs {
        let Some(groups) = doc.pointer("/hooks/PreToolUse").and_then(|g| g.as_array()) else {
            continue;
        };
        for hook in groups
            .iter()
            .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
            .flatten()
        {
            let command = hook.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let args: Vec<&str> = hook
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let references =
                command.contains(GUARD_SCRIPT) || args.iter().any(|a| a.contains(GUARD_SCRIPT));
            if references {
                out.push(GuardHook {
                    interpreter: interpreter_of(command, !args.is_empty()),
                });
            }
        }
    }
    out
}

/// Fold the guard registrations into the contract shape. `resolves` answers
/// "is this program runnable on the PATH `claude` gets" — injected so tests
/// never depend on the machine's PATH; `None` skips the check (WSL: the host
/// PATH says nothing about the distro's).
pub fn guard_health(docs: &[Value], resolves: Option<&dyn Fn(&str) -> bool>) -> ClaudeGuardHealth {
    let guards = find_guards(docs);
    let interpreter_missing = resolves.and_then(|resolves| {
        guards
            .iter()
            .filter_map(|g| g.interpreter.as_deref())
            .find(|i| !resolves(i))
            .map(str::to_string)
    });
    ClaudeGuardHealth {
        registered: !guards.is_empty(),
        interpreter_missing,
    }
}

/// Whether `program` would run on the login-shell PATH Francois spawns with.
fn program_resolves(program: &str) -> bool {
    if program.contains('/') || program.contains('\\') {
        return Path::new(program).is_file();
    }
    crate::process_util::resolve_program(program).is_some()
}

// ---------- the I/O half ----------

/// The whole probe for one Claude session's project.
pub fn project_health(cwd: &str, runtime: &str, config_dir: Option<&str>) -> ClaudeProjectHealth {
    let key = trust_key(cwd, runtime);
    let doc = claude_json_path(config_dir, runtime, cwd)
        .and_then(|p| read_json_object(&p).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let docs = cwd_settings_docs(cwd);
    let resolves: &dyn Fn(&str) -> bool = &program_resolves;
    ClaudeProjectHealth {
        trust: ClaudeTrustHealth {
            trusted: node_trusted(&doc, &key),
            key,
            allow_rule_count: allow_rule_count(&docs),
        },
        guard: guard_health(&docs, (runtime != "wsl").then_some(resolves)),
    }
}

/// Set `projects[<key>].hasTrustDialogAccepted = true` in the `.claude.json` at
/// `path`, preserving every other field, creating the file / node if absent.
/// Refuses (never overwrites) a file that is not a JSON object, or whose node
/// is not an object.
pub fn write_trust(path: &Path, key: &str) -> Result<(), AppError> {
    let mut doc = read_json_object(path)?;
    if apply_decision(&mut doc, key, &[], &[], true) {
        write_json_atomic(path, &doc)?;
    }
    if !node_trusted(&doc, key) {
        return Err(AppError::new(
            ErrorCode::SettingsWriteFailed,
            format!(
                "{}: projects[\"{key}\"] is not a JSON object",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// (cwd, runtime, Claude config dir) for a Claude session; `Err(None)` for an
/// unknown session, `Err(Some(()))` for a non-Claude runtime.
fn claude_target_of(
    app: &AppHandle,
    engine: &Engine,
    session_id: &str,
) -> Result<(String, String, Option<String>), Option<()>> {
    let (cwd, runtime, account_id, agent) = engine
        .with_session(session_id, |s| {
            (
                s.cwd.clone(),
                s.runtime.clone(),
                s.account_id.clone(),
                s.agent_runtime,
            )
        })
        .ok_or(None)?;
    if agent != AgentRuntime::ClaudeCode {
        return Err(Some(()));
    }
    // `claude_config_dir_of`, not `config_dir_of`: the latter hands back a
    // Codex/endpoint account's home, which is not a Claude config.
    let config_dir = crate::account::claude_config_dir_of(app, &account_id);
    Ok((cwd, runtime, config_dir))
}

// ---------- commands ----------

/// francois:session:projectHealth — folder trust + Cohorte guard diagnostics.
#[tauri::command(async)]
pub fn session_project_health(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<ClaudeProjectHealth> {
    match claude_target_of(&app, &engine, &session_id) {
        Ok((cwd, runtime, config_dir)) => ok(project_health(&cwd, &runtime, config_dir.as_deref())),
        Err(Some(())) => ok(ClaudeProjectHealth::neutral()),
        Err(None) => err(ErrorCode::SessionNotFound, "no such session"),
    }
}

/// francois:session:trustFolder — record the folder-trust answer for this
/// session's exact `-p` key, then answer with the new health. Only ever called
/// from an explicit click.
#[tauri::command(async)]
pub fn session_trust_folder(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<ClaudeProjectHealth> {
    let (cwd, runtime, config_dir) = match claude_target_of(&app, &engine, &session_id) {
        Ok(t) => t,
        Err(Some(())) => {
            return err(
                ErrorCode::RuntimeUnsupported,
                "folder trust is a Claude Code setting",
            )
        }
        Err(None) => return err(ErrorCode::SessionNotFound, "no such session"),
    };
    let Some(path) = claude_json_path(config_dir.as_deref(), &runtime, &cwd) else {
        return err(
            ErrorCode::SettingsWriteFailed,
            "could not locate the Claude Code config directory for this session",
        );
    };
    if let Err(e) = write_trust(&path, &trust_key(&cwd, &runtime)) {
        return err(e.code, e.message);
    }
    ok(project_health(&cwd, &runtime, config_dir.as_deref()))
}

#[cfg(test)]
mod tests;

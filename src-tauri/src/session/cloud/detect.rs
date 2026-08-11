//! FR-6 / FR-8 — reading the teleport PTY, and finding the local session it
//! hydrated. Everything here is a plain function over owned data (or over a
//! directory), so `adopt.rs` only wires these into a thread and a poll loop.
//!
//! Two jobs:
//!  * **FR-8, the verdict.** Teleport is an interactive TUI: when it needs a
//!    decision it PARKS and waits for a keypress that will never come. Matching
//!    its blocking dialogs turns a 180s timeout into an immediate, named
//!    failure. Francois never auto-answers them — a repo mismatch, a stash and a
//!    trust prompt are the user's decisions, not this app's.
//!  * **FR-6, the handoff.** The pre-minted `--session-id` makes the handoff
//!    deterministic, but `--teleport` is a hidden flag (§7 #1), so there is a
//!    fallback: the newest transcript in the same project directory modified
//!    at/after the spawn instant. The mtime gate is load-bearing — a long-lived
//!    project directory is full of older transcripts, and adopting one of those
//!    would resume somebody else's thread.

use super::*;

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// FR-8's verdict: a blocking dialog matched, with the code and the message the
/// adoption fails with. `detail` carries the machine-readable half where the
/// contract defines one (`CLOUD_REPO_MISMATCH`'s `{ sessionRepo, currentRepo }`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CloudBlock {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) detail: Option<Value>,
}

/// The words teleport uses when the checkout is not the session's repository.
/// Verified only as the CLI's documented phrasing, not live — which is why the
/// three variants are matched independently rather than as one sentence.
const REPO_MISMATCH_MARK: &str = "from a checkout of";
const NOT_IN_REPO_MARK: &str = "not in a git repository";
const HOST_UNVERIFIED_MARK: &str = "host has not been verified";
const HOST_UNVERIFIED_ALT: &str = "host_unverified";
const STASH_MARK: &str = "uncommitted changes";
const STASH_CONFIRM: &str = "stash";
const MCP_MARK: &str = "New MCP server found";
const MCP_CONFIRM: &str = "Use this MCP server";
const TRUST_DIALOG: &str = "Trust this directory?";
const TRUST_LEGACY: &str = "Do you trust the files in this folder";
const TRUST_REFUSED: &str = "Workspace not trusted";

/// The two refusals the API also names (`api.rs`'s `classify_api_error`), matched
/// here because teleport can meet them in the PTY instead — an org that turned
/// `allow_remote_sessions` off, or a machine that was never enrolled. Without
/// these the user waits out the whole FR-9 deadline for a generic stall, and
/// `CLOUD_DEVICE_UNTRUSTED`/`CLOUD_POLICY_DENIED` are unreachable in `cloud_adopt`
/// despite being in its contract union.
///
/// Matched against the LOWERCASED frame and deliberately narrow: "trusted device"
/// alone would fire on "Trusted devices are listed in your settings", and sending
/// a user to an administrator over ordinary prose is worse than a slow timeout.
const DEVICE_MARKS: [&str; 4] = [
    "untrusted_device",
    "device is not trusted",
    "device not trusted",
    "device not enrolled",
];
const POLICY_MARKS: [&str; 4] = [
    "allow_remote_sessions",
    "disabled by your organization",
    "organization has disabled",
    "organization has turned",
];

/// The repository the mismatch dialog names, if it names one: the first token
/// after "from a checkout of", stripped of trailing punctuation. Best-effort —
/// an unrecognized wording yields `None` and the error simply carries no
/// `sessionRepo`, rather than a guess the user would act on.
pub(crate) fn repo_from_mismatch(normalized: &str) -> Option<String> {
    let at = normalized.find(REPO_MISMATCH_MARK)? + REPO_MISMATCH_MARK.len();
    let token = normalized[at..]
        .split_whitespace()
        .next()?
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '.' && c != '-');
    (!token.is_empty()).then(|| token.to_string())
}

/// FR-8: does this frame of normalized PTY output mean the adoption is parked
/// (or already refused)? `None` means "keep waiting".
///
/// The wording is teleport's, not ours: the returned MESSAGE is ours, because
/// the CLI's own auth/teleport errors are phrased in Remote Control's
/// vocabulary (§7 #4) and this feature's UI must never repeat that phrase.
///
/// `phase` is the phase the adoption is in RIGHT NOW — it becomes
/// `CLOUD_ADOPT_STALLED`'s documented `detail: { phase }` (contract/common.ts), so
/// a stall found in the PTY renders exactly like the FR-9 deadline's.
pub(crate) fn teleport_block(
    normalized: &str,
    current_repo: Option<&str>,
    phase: &str,
) -> Option<CloudBlock> {
    let stalled = |message: &str| {
        Some(CloudBlock {
            code: "CLOUD_ADOPT_STALLED",
            message: message.to_string(),
            detail: Some(serde_json::json!({ "phase": phase })),
        })
    };
    let lower = normalized.to_lowercase();
    // The two named refusals first: they are verdicts, not prompts, and their
    // wording can co-occur with a trust or stash dialog on the same frame.
    if DEVICE_MARKS.iter().any(|m| lower.contains(m)) {
        return Some(CloudBlock {
            code: "CLOUD_DEVICE_UNTRUSTED",
            message: DEVICE_UNTRUSTED_MSG.to_string(),
            detail: None,
        });
    }
    if POLICY_MARKS.iter().any(|m| lower.contains(m)) {
        return Some(CloudBlock {
            code: "CLOUD_POLICY_DENIED",
            message: POLICY_DENIED_MSG.to_string(),
            detail: None,
        });
    }
    if normalized.contains(REPO_MISMATCH_MARK)
        || normalized.contains(NOT_IN_REPO_MARK)
        || normalized.contains(HOST_UNVERIFIED_MARK)
        || normalized.contains(HOST_UNVERIFIED_ALT)
    {
        let session_repo = repo_from_mismatch(normalized);
        let named = session_repo
            .as_deref()
            .map(|r| format!(" It belongs to {r}."))
            .unwrap_or_default();
        return Some(CloudBlock {
            code: "CLOUD_REPO_MISMATCH",
            message: format!(
                "This cloud session cannot be adopted into that directory.{named} \
                 Adopt it into a checkout of the same repository — a fork does not count."
            ),
            detail: Some(serde_json::json!({
                "sessionRepo": session_repo,
                "currentRepo": current_repo,
            })),
        });
    }
    if normalized.contains(STASH_MARK) && lower.contains(STASH_CONFIRM) {
        return stalled(
            "Teleport is waiting for a decision about the uncommitted changes in that \
             checkout. Commit or stash them yourself, or land the session in a fresh \
             worktree instead.",
        );
    }
    if normalized.contains(MCP_MARK) && normalized.contains(MCP_CONFIRM) {
        return stalled(
            "Claude Code is waiting for MCP server approval in that directory — approve \
             it in the MCP SERVERS panel [4], then adopt again.",
        );
    }
    if normalized.contains(TRUST_DIALOG)
        || normalized.contains(TRUST_LEGACY)
        || normalized.contains(TRUST_REFUSED)
    {
        return stalled(
            "Claude Code has not been told it may run in that directory — trust it in \
             the MCP SERVERS panel [4], then adopt again.",
        );
    }
    None
}

/// FR-7: has teleport got as far as putting the branch on disk? Best-effort —
/// these are git's own words plus teleport's, and a miss only means the
/// `hydrating` phase is emitted a moment later (the adoption emits it
/// unconditionally before `ready`, so the FR-7 sequence never has a hole).
pub(crate) fn checkout_marker(normalized: &str) -> bool {
    const MARKS: [&str; 5] = [
        "Switched to branch",
        "Already on",
        "HEAD is now at",
        "Checked out",
        "Checking out",
    ];
    MARKS.iter().any(|m| normalized.contains(m))
}

/// What the reader thread learned from one chunk of teleport's PTY output.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CloudReaderAction {
    /// FR-8: parked or refused — fail now and reap the child.
    Blocked(CloudBlock),
    /// FR-7: the branch landed; the adoption is hydrating from here on.
    CheckedOut,
}

/// Append `chunk` to `carry` and decide (FR-8). Owns the same carry bookkeeping
/// as remote-control's reader — the trailing-window trim on a UTF-8 char
/// boundary (a mid-character cut PANICS, which would kill the only thread
/// draining the master and hang the child forever) and frame-scoping, so a
/// screen clear drops a stale frame instead of matching text teleport already
/// scrolled past.
pub(crate) fn cloud_feed(
    carry: &mut String,
    chunk: &str,
    current_repo: Option<&str>,
    phase: &str,
) -> Option<CloudReaderAction> {
    if chunk.contains("\u{1b}[2J") || chunk.contains("\u{1b}[3J") {
        carry.clear();
    }
    carry.push_str(chunk);
    if carry.len() > 16_384 {
        let mut cut = carry.len() - 4_096;
        while !carry.is_char_boundary(cut) {
            cut += 1;
        }
        *carry = carry[cut..].to_string();
    }
    let normalized = normalize_pty(carry);
    if let Some(block) = teleport_block(&normalized, current_repo, phase) {
        return Some(CloudReaderAction::Blocked(block));
    }
    checkout_marker(&normalized).then_some(CloudReaderAction::CheckedOut)
}

// ---------- FR-6: finding the transcript ----------

/// The working directory as the CLI itself sees it — which is what
/// `project_slug` has to be computed from. For the `wsl` runtime that is the
/// Linux path inside the distro, not the `\\wsl$\…` UNC path Windows uses.
pub(crate) fn claude_cwd(runtime: &str, cwd: &str) -> String {
    if runtime == "wsl" {
        if let Some((_, linux)) = crate::wsl::wsl_unc_to_linux(cwd) {
            return linux;
        }
    }
    cwd.to_string()
}

/// FR-6's directory: `<configDir>/projects/<slug>`.
///
/// `<configDir>` is the account's `CLAUDE_CONFIG_DIR` when it has one — which
/// holds for the `wsl` runtime too, because the variable crosses the boundary
/// with `/p` translation (multi-account FR-24), so the transcript lands on the
/// Windows side either way. Only the built-in account under `wsl` needs the
/// distro's own `$HOME` (§7 #7), reached through the same UNC translation
/// permission-guardrails uses for `~/.claude/settings.json`.
pub(crate) fn transcript_dir(
    config_dir: Option<&str>,
    runtime: &str,
    cwd: &str,
) -> Option<PathBuf> {
    let base = match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None if runtime == "wsl" => PathBuf::from(crate::wsl::wsl_home_unc(cwd)?).join(".claude"),
        None => dirs::home_dir()?.join(".claude"),
    };
    Some(
        base.join("projects")
            .join(project_slug(&claude_cwd(runtime, cwd))),
    )
}

fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn has_content(path: &Path) -> bool {
    matches!(std::fs::metadata(path), Ok(m) if m.is_file() && m.len() > 0)
}

/// FR-6's fallback: the newest `<id>.jsonl` in `dir` modified at/after
/// `since_ms`, as its id. The mtime gate is what makes this safe — a project
/// directory accumulates a transcript per session, and the newest one overall is
/// almost never this run's.
pub(crate) fn newest_transcript_since(dir: &Path, since_ms: u64) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "jsonl") || !has_content(&path) {
            continue;
        }
        let Some(modified) = modified_ms(&path) else {
            continue;
        };
        if modified < since_ms {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(m, _)| modified > *m) {
            best = Some((modified, stem.to_string()));
        }
    }
    best.map(|(_, id)| id)
}

/// FR-6: the local session teleport hydrated — the pre-minted id when its
/// transcript is on disk, else the newest transcript written since the spawn.
/// `None` ⇒ nothing has landed yet; the caller keeps waiting until the FR-9
/// deadline.
pub(crate) fn hydrated_session_id(dir: &Path, minted: &str, since_ms: u64) -> Option<String> {
    if has_content(&dir.join(format!("{minted}.jsonl"))) {
        return Some(minted.to_string());
    }
    newest_transcript_since(dir, since_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("francois-cloud-{tag}-{}", uuid()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    // ---- FR-8: the blocking dialogs ----

    #[test]
    fn a_repo_mismatch_dialog_fails_with_both_repos() {
        // The TUI places each word with its own cursor-forward code, so the
        // phrase is only greppable after normalization.
        let raw = "Run\u{1b}[1Cclaude\u{1b}[1C--teleport\u{1b}[1Cfrom\u{1b}[1Ca\u{1b}[1Ccheckout\u{1b}[1Cof\u{1b}[1Cacme/api";
        let block = teleport_block(&normalize_pty(raw), Some("me/api-fork"), "teleporting")
            .expect("must be detected");
        assert_eq!(block.code, "CLOUD_REPO_MISMATCH");
        let detail = block.detail.expect("detail");
        assert_eq!(detail["sessionRepo"], "acme/api");
        assert_eq!(detail["currentRepo"], "me/api-fork");
        assert!(
            block.message.contains("acme/api"),
            "the message names the repo it wants: {}",
            block.message
        );
    }

    #[test]
    fn host_unverified_and_not_in_repo_are_the_same_named_failure() {
        for raw in [
            "Error: the host has not been verified for this session",
            "host_unverified",
            "fatal: not in a git repository",
        ] {
            let block = teleport_block(&normalize_pty(raw), None, "teleporting").expect("detected");
            assert_eq!(block.code, "CLOUD_REPO_MISMATCH", "on {raw}");
        }
        // With no repo named, the detail is honest about it rather than guessing.
        let block = teleport_block("host_unverified", None, "teleporting").unwrap();
        assert_eq!(block.detail.unwrap()["sessionRepo"], Value::Null);
    }

    #[test]
    fn the_stash_prompt_stalls_rather_than_being_answered() {
        // FR-8: Francois never auto-answers — this is the user's decision, and
        // the message must say what they can do instead.
        let raw = "You\u{1b}[1Chave\u{1b}[1Cuncommitted\u{1b}[1Cchanges. Stash\u{1b}[1Cthem\u{1b}[1Cand\u{1b}[1Ccontinue?";
        let block = teleport_block(&normalize_pty(raw), None, "teleporting").expect("detected");
        assert_eq!(block.code, "CLOUD_ADOPT_STALLED");
        assert!(block.message.contains("worktree"), "{}", block.message);
    }

    #[test]
    fn the_mcp_and_trust_dialogs_stall_with_the_in_app_fix() {
        let mcp = "New MCP server found in this project: serena Use this MCP server?";
        let block = teleport_block(mcp, None, "teleporting").expect("detected");
        assert_eq!(block.code, "CLOUD_ADOPT_STALLED");
        assert!(block.message.contains("panel [4]"), "{}", block.message);

        for raw in [
            "Trust this directory?",
            "Do you trust the files in this folder",
            "Error: Workspace not trusted. Please run `claude` in D:\\repo first",
        ] {
            let block = teleport_block(&normalize_pty(raw), None, "teleporting").expect("detected");
            assert_eq!(block.code, "CLOUD_ADOPT_STALLED", "on {raw}");
        }
    }

    #[test]
    fn every_stall_carries_the_phase_it_stalled_in() {
        // contract/common.ts documents CLOUD_ADOPT_STALLED's detail as
        // `{ phase }`. A dialog-triggered stall reaches the same renderer as the
        // FR-9 deadline, so it cannot arrive without one.
        let dialogs = [
            "You have uncommitted changes. Stash them?",
            "New MCP server found in this project: x Use this MCP server?",
            "Trust this directory?",
            "Do you trust the files in this folder",
            "Error: Workspace not trusted",
        ];
        for raw in dialogs {
            assert_eq!(
                teleport_block(raw, None, "hydrating").unwrap().code,
                "CLOUD_ADOPT_STALLED",
                "on {raw}"
            );
            let block = teleport_block(raw, None, "hydrating").expect("detected");
            let detail = block
                .detail
                .unwrap_or_else(|| panic!("no detail on {:?}: {raw}", block.code));
            assert_eq!(detail["phase"], "hydrating", "on {raw}");
        }
    }

    #[test]
    fn the_device_and_policy_refusals_are_named_rather_than_left_to_the_deadline() {
        // §2 Goal: "a named, actionable failure for every documented precondition".
        // Both codes are in cloud_adopt's contract union, and teleport refuses in
        // the PTY — without these the user waits out the full FR-9 deadline for a
        // generic stall.
        for raw in [
            "untrusted_device",
            "This device is not trusted. Run /login to enrol it.",
            "Error: device not enrolled for cloud sessions",
        ] {
            let block = teleport_block(&normalize_pty(raw), None, "teleporting").expect("detected");
            assert_eq!(block.code, "CLOUD_DEVICE_UNTRUSTED", "on {raw}");
            assert!(block.message.contains("/login"), "{}", block.message);
        }
        for raw in [
            "allow_remote_sessions is disabled",
            "Cloud sessions are disabled by your organization",
            "Error: your organization has disabled remote sessions",
        ] {
            let block = teleport_block(&normalize_pty(raw), None, "teleporting").expect("detected");
            assert_eq!(block.code, "CLOUD_POLICY_DENIED", "on {raw}");
            assert!(
                block.message.contains("administrator"),
                "{}",
                block.message
            );
        }
    }

    #[test]
    fn no_cloud_failure_message_ever_says_remote_control() {
        // §7 #4: teleport rides Remote Control's infrastructure and may say so.
        // Nothing this module returns may repeat that phrase — it is a different
        // object, and naming it would send users to the wrong control.
        let samples = [
            "Run claude --teleport from a checkout of acme/api",
            "You have uncommitted changes. Stash them?",
            "New MCP server found in this project: x Use this MCP server?",
            "Trust this directory?",
            "untrusted_device",
            "allow_remote_sessions is disabled",
        ];
        for raw in samples {
            let block = teleport_block(raw, None, "teleporting").expect("detected");
            assert!(
                !block.message.to_lowercase().contains("remote control"),
                "leaked the phrase: {}",
                block.message
            );
        }
    }

    #[test]
    fn ordinary_teleport_output_is_not_a_stall() {
        assert_eq!(teleport_block("", None, "teleporting"), None);
        assert_eq!(
            teleport_block("Fetching cloud session…", None, "teleporting"),
            None
        );
        assert_eq!(
            teleport_block(
                &normalize_pty("\u{1b}[2mwelcome to claude code"),
                None,
                "teleporting"
            ),
            None
        );
        // The words the matchers key on must not fire out of ordinary prose —
        // a false CLOUD_POLICY_DENIED would send the user to an administrator
        // over nothing.
        assert_eq!(
            teleport_block("Reading your permission policy for this directory", None, "x"),
            None
        );
        assert_eq!(
            teleport_block("Trusted devices are listed in your settings page", None, "x"),
            None
        );
    }

    // ---- FR-7: the checkout marker ----

    #[test]
    fn the_checkout_marker_moves_the_phase_to_hydrating() {
        assert!(checkout_marker("Switched to branch 'fix/flake'"));
        assert!(checkout_marker("Already on 'main'"));
        assert!(checkout_marker("Checked out branch fix/flake"));
        assert!(!checkout_marker("Fetching cloud session…"));
    }

    // ---- the reader's decision function ----

    #[test]
    fn feed_reports_a_block_across_two_reads() {
        // The dialog can straddle a read boundary; the carry is what joins them.
        let mut carry = String::new();
        assert_eq!(
            cloud_feed(
                &mut carry,
                "Run claude --teleport from a ",
                None,
                "teleporting"
            ),
            None
        );
        match cloud_feed(&mut carry, "checkout of acme/api\r\n", None, "teleporting") {
            Some(CloudReaderAction::Blocked(b)) => assert_eq!(b.code, "CLOUD_REPO_MISMATCH"),
            other => panic!("expected a block, got {other:?}"),
        }
    }

    #[test]
    fn feed_reports_the_phase_the_reader_was_in() {
        // The reader thread reads the LIVE phase, so a stall detected while the
        // adoption was already hydrating says `hydrating`, not the phase it
        // spawned in.
        let mut carry = String::new();
        match cloud_feed(&mut carry, "Trust this directory?", None, "hydrating") {
            Some(CloudReaderAction::Blocked(b)) => {
                assert_eq!(b.detail.unwrap()["phase"], "hydrating")
            }
            other => panic!("expected a block, got {other:?}"),
        }
    }

    #[test]
    fn feed_frame_scopes_so_a_screen_clear_drops_a_stale_dialog() {
        let mut carry = String::from("Trust this directory?");
        assert_eq!(
            cloud_feed(&mut carry, "\u{1b}[2Jwelcome back", None, "teleporting"),
            None
        );
        assert!(!carry.contains("Trust this directory?"), "{carry}");
    }

    #[test]
    fn feed_trims_a_multibyte_carry_without_panicking() {
        // '─' is 3 bytes; `len - 4096` lands two bytes INTO a character, which
        // would panic — and the panicking thread is the only one draining the
        // PTY master, so the child would hang alive forever.
        let mut carry: String = "─".repeat(6_000);
        let before = carry.len();
        assert_eq!(cloud_feed(&mut carry, "more", None, "teleporting"), None);
        assert!(carry.len() < before);
        assert!(carry.ends_with("more"));
    }

    // ---- FR-6: transcript discovery ----

    #[test]
    fn the_pre_minted_id_wins_when_its_transcript_exists() {
        let dir = tmpdir("minted");
        touch(&dir, "11111111-2222-3333-4444-555555555555.jsonl", "{}\n");
        assert_eq!(
            hydrated_session_id(&dir, "11111111-2222-3333-4444-555555555555", 0).as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_transcript_is_not_hydrated_yet() {
        // The file appears the moment the CLI opens it; adopting on existence
        // alone would hand back a session with no conversation in it.
        let dir = tmpdir("empty");
        touch(&dir, "aaaa.jsonl", "");
        assert_eq!(hydrated_session_id(&dir, "aaaa", 0), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_fallback_ignores_transcripts_older_than_this_run() {
        // FR-6's mtime gate: a long-lived project dir is full of past sessions,
        // and adopting one of those would resume somebody else's thread.
        let dir = tmpdir("mtime");
        let old = touch(&dir, "old-session.jsonl", "{}\n");
        let old_ms = modified_ms(&old).unwrap();
        assert_eq!(newest_transcript_since(&dir, old_ms + 60_000), None);
        // Anything at/after the spawn instant IS this run's.
        assert_eq!(
            newest_transcript_since(&dir, 0).as_deref(),
            Some("old-session")
        );
        assert_eq!(
            hydrated_session_id(&dir, "never-written", old_ms + 60_000),
            None
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_fallback_skips_non_transcripts_and_a_missing_directory() {
        let dir = tmpdir("filter");
        touch(&dir, "notes.txt", "{}\n");
        assert_eq!(newest_transcript_since(&dir, 0), None);
        assert_eq!(newest_transcript_since(&dir.join("absent"), 0), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- the transcript directory ----

    #[test]
    fn the_transcript_directory_is_the_config_dirs_project_slug() {
        let dir = transcript_dir(Some("D:\\francois\\accounts\\a1"), "native", "D:\\repo")
            .expect("resolves");
        assert_eq!(
            dir,
            PathBuf::from("D:\\francois\\accounts\\a1")
                .join("projects")
                .join("D--repo")
        );
    }

    #[test]
    fn a_wsl_cwd_slugs_the_path_the_cli_actually_sees() {
        // §7 #7: inside the distro the cwd is a Linux path, so the slug must be
        // of THAT, not of the `\\wsl$\…` form Windows uses.
        assert_eq!(
            claude_cwd("wsl", "\\\\wsl.localhost\\Ubuntu\\home\\u\\api"),
            "/home/u/api"
        );
        // A worktree session's cwd is already a bare Linux path.
        assert_eq!(claude_cwd("wsl", "/home/u/api"), "/home/u/api");
        // The native runtime never translates.
        assert_eq!(claude_cwd("native", "D:\\repo"), "D:\\repo");

        let dir = transcript_dir(
            Some("D:\\accounts\\a1"),
            "wsl",
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api",
        )
        .expect("resolves");
        assert!(
            dir.ends_with("-home-u-api"),
            "slug must come from the Linux path: {dir:?}"
        );
    }
}

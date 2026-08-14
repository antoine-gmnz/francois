//! FR-5..FR-12 — `francois:cloud:adopt`: the teleport PTY, the phase machine,
//! and the ordinary local session the whole feature exists to produce. Where the
//! adoption lands on disk, and what a failure has to undo, is `landing.rs`.
//!
//! The handoff is by PRE-MINTED id, not by parsing: Francois mints a uuid and
//! spawns `claude --teleport <cloudId> --session-id <uuid>`, so the local
//! session teleport hydrates — and therefore the `claudeSessionId` every later
//! `claude --resume` turn uses — is known before the child has said anything.
//! FR-6's newest-transcript fallback exists because `--teleport` is a hidden
//! flag (§7 #1), not because the primary path is doubtful.
//!
//! Interactive, never `-p`: teleport drives a real REPL, and print mode has no
//! branch checkout and no hydration.

use super::*;

use crate::ipc::{err, err_detail, ok, IpcResult};
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::State;

/// A child that exits without ever writing a transcript gets this long for its
/// last write to land before the adoption is called failed — the file appears a
/// beat after the process is done with it.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// Where a failed adoption writes what teleport printed, under the app data dir.
const ADOPT_LOG: &str = "cloud-adopt.log";
/// How much of the PTY window a failure carries into that log. Enough for a full
/// dialog and the lines around it; not the whole 16K window, which is mostly the
/// REPL's boot banner redrawn.
const PTY_EXCERPT_CHARS: usize = 2_000;

const CONFIRM_MSG: &str =
    "Landing in the project's own checkout stashes its uncommitted changes. Confirm the \
     destination before adopting, or land the session in a fresh worktree instead.";
const UNKNOWN_DESTINATION_MSG: &str =
    "Unknown landing. A cloud session lands either in a fresh worktree or in the project's \
     own checkout.";
const BAD_REF_MSG: &str =
    "That is not a Claude Code on the web session. Paste a claude.ai/code link, or the \
     session id it ends with.";
const ALREADY_MSG: &str = "An adoption of that cloud session is already running.";
const PROJECT_MSG: &str = "no such project";
const EXITED_MSG: &str =
    "Teleport exited without handing over a local session. Check that the session's branch \
     is pushed and that you are signed in to the same claude.ai account.";

// ---------- pure helpers ----------

/// FR-5's argv after `claude`. Interactive on purpose — `-p` would give a print
/// run with no checkout and no hydration, which is the same silent no-op Remote
/// Control has under print mode.
pub(crate) fn teleport_args(cloud_id: &str, session_uuid: &str) -> Vec<String> {
    vec![
        "--teleport".to_string(),
        cloud_id.to_string(),
        "--session-id".to_string(),
        session_uuid.to_string(),
    ]
}

/// FR-5: the runtime teleport spawns under. Taken from the project's session
/// defaults, because this creation path has no modal to read them from; an
/// unknown value, or `wsl` off Windows, falls back to native rather than
/// failing an adoption over a stale default.
pub(crate) fn adopt_runtime(project_default: Option<&str>) -> String {
    match project_default {
        Some(r) if valid_runtime(r) && (cfg!(windows) || r != "wsl") => r.to_string(),
        _ => "native".to_string(),
    }
}

/// FR-12/FR-3: everything `cloud_adopt` can refuse before it touches git, a
/// process or the network, in the order it has to refuse them. Returns the
/// normalized `(destination, cloudId)`.
///
/// The destructive landing is checked BEFORE the ref: an unconfirmed `checkout`
/// reported as a bad ref would send the user to fix the ref and then stash their
/// uncommitted work on the retry.
pub(crate) fn validate_adopt_request(
    destination: &str,
    confirmed: Option<bool>,
    r#ref: &str,
) -> Result<(String, String), (&'static str, &'static str)> {
    let destination = destination.trim();
    if destination != "worktree" && destination != "checkout" {
        return Err(("INVALID_INPUT", UNKNOWN_DESTINATION_MSG));
    }
    // FR-12: the core never stashes on the user's behalf — teleport does, and
    // this flag is what makes that consented.
    if destination == "checkout" && confirmed != Some(true) {
        return Err(("INVALID_INPUT", CONFIRM_MSG));
    }
    let Some(cloud_id) = normalize_cloud_ref(r#ref) else {
        return Err(("INVALID_INPUT", BAD_REF_MSG));
    };
    Ok((destination.to_string(), cloud_id))
}

/// FR-3 / §2: what the pre-spawn lookup does to the adoption about to run.
///
/// An unhelpful answer is NOT fatal — teleport validates the session itself and
/// FR-4 has a fallback branch name — but a refusal the user can act on has to
/// land "within seconds, not a spinner" (story 5), and a 404 means there is
/// nothing to adopt at all. Both are in `cloud_adopt`'s contract error union and
/// are unreachable if the verdict is flattened to an `Option` here.
pub(crate) fn adopt_meta(
    verdict: CloudLookup,
    cloud_id: &str,
) -> Result<Option<CloudSession>, AdoptError> {
    match verdict {
        CloudLookup::Found(session) => Ok(Some(session)),
        CloudLookup::Unknown => Ok(None),
        CloudLookup::Actionable(code, message) => Err(AdoptError::new(code, message)),
        CloudLookup::NotFound => {
            let (code, message) = session_not_found(cloud_id);
            Err(AdoptError::new(code, message))
        }
    }
}

/// The adopted session's display name: the cloud session's title when it is a
/// usable session name, else the landing directory's basename — the same
/// fallback `session_create` uses. Never synthesized from the id (spec §7 #3:
/// an invented title is worse than none).
pub(crate) fn adopt_name(title: Option<&str>, cwd: &str) -> String {
    title
        .and_then(|t| validate_session_name(t).ok())
        .unwrap_or_else(|| basename(cwd))
}

/// The last `n` characters of `text`. The END of a PTY window is the part that
/// explains a stall — the dialog currently on screen — and the start is boot
/// noise. Counted in CHARACTERS, not bytes: a TUI window is full of box-drawing
/// glyphs and a byte cut would land inside one.
pub(crate) fn last_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    if count <= n {
        return text.to_string();
    }
    text.chars().skip(count - n).collect()
}

/// Reaps a freshly spawned child on every early return before it is handed to
/// the reader thread. `portable_pty::Child` does not kill on drop, and a child
/// that never reaches the registry can never be found by
/// `kill_all_cloud_adoptions`.
struct KillOnErr(Option<Box<dyn Child + Send + Sync>>);

impl KillOnErr {
    fn disarm(mut self) -> Box<dyn Child + Send + Sync> {
        self.0.take().expect("disarm called at most once")
    }
}

impl Drop for KillOnErr {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

// ---------- FR-5: the teleport PTY ----------

struct AdoptPty {
    blocked: Arc<Mutex<Option<CloudBlock>>>,
    checked_out: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    /// The reader's rolling window of RAW PTY text. Teleport's own output is the
    /// only witness to a stall — an FR-8 miss (a dialog reworded by a CLI
    /// release) is indistinguishable from a hang once it has been discarded,
    /// which is exactly the "stuck on Teleporting, nothing happens" report.
    /// Kept raw and normalized only when a failure has to explain itself.
    tail: Arc<Mutex<String>>,
}

/// Opens the PTY, builds argv/env exactly like a normal turn
/// (`claude_invocation` + `account_env`), spawns the interactive teleport child
/// on it, and starts the one thread that drains the master. Draining is not
/// optional: an unread master eventually blocks the child (FR-9).
#[allow(clippy::too_many_arguments)]
fn spawn_teleport(
    reg: &CloudAdoptRegistry,
    key: &str,
    exe: &str,
    argv: &[String],
    cwd: &str,
    runtime: &str,
    config_dir: Option<&str>,
    current_repo: Option<String>,
    phase: Arc<Mutex<CloudAdoptPhase>>,
) -> Result<AdoptPty, AdoptError> {
    let pair = native_pty_system()
        .openpty(PtySize {
            // Wide enough that teleport's dialogs are not wrapped mid-phrase,
            // which would defeat the FR-8 matcher.
            rows: 50,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AdoptError::new("PTY_ERROR", format!("could not open a pty: {e}")))?;

    let mut cmd = CommandBuilder::new(exe);
    for arg in argv {
        cmd.arg(arg);
    }
    if runtime != "wsl" {
        cmd.cwd(cwd); // wsl positions itself via `--cd` inside claude_invocation
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(path) = claude_path_env() {
        cmd.env("PATH", path);
    }
    // multi-account FR-21: teleport is a claude spawn made on behalf of the
    // session being created, so it runs under that session's account. TERM must
    // cross the wsl.exe boundary too — the PTY is the only FR-8 signal there.
    for (k, v) in account_env(config_dir, runtime, &["TERM/u"]) {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AdoptError::new("SPAWN_FAILED", format!("could not start {exe}: {e}")))?;
    drop(pair.slave);
    let mut guard = KillOnErr(Some(child));

    let killer = guard.0.as_mut().unwrap().clone_killer();
    let reader = pair.master.try_clone_reader().map_err(|e| {
        AdoptError::new(
            "PTY_ERROR",
            format!("could not read teleport's output: {e}"),
        )
    })?;

    let blocked: Arc<Mutex<Option<CloudBlock>>> = Arc::new(Mutex::new(None));
    let checked_out = Arc::new(AtomicBool::new(false));
    let exited = Arc::new(AtomicBool::new(false));
    let tail = Arc::new(Mutex::new(String::new()));
    let child = guard.disarm();
    reg.attach(key, killer, pair.master);
    spawn_reader_thread(
        reader,
        child,
        blocked.clone(),
        checked_out.clone(),
        exited.clone(),
        tail.clone(),
        current_repo,
        phase,
    );
    Ok(AdoptPty {
        blocked,
        checked_out,
        exited,
        tail,
    })
}

/// The single background thread: drains the master (mandatory), and publishes
/// the two things the adoption loop reads — an FR-8 verdict and the FR-7
/// checkout marker. It does NOT kill the child on a block: the registry entry
/// owns the killer, and the loop's teardown is the one place that reaps.
#[allow(clippy::too_many_arguments)]
fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    blocked: Arc<Mutex<Option<CloudBlock>>>,
    checked_out: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    tail: Arc<Mutex<String>>,
    current_repo: Option<String>,
    phase: Arc<Mutex<CloudAdoptPhase>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    // The LIVE phase: a stall found while the adoption was already
                    // hydrating must say so in CLOUD_ADOPT_STALLED's `{ phase }`.
                    let at = phase_name(&phase.lock().unwrap());
                    match cloud_feed(&mut carry, &chunk, current_repo.as_deref(), at) {
                        Some(CloudReaderAction::Blocked(block)) => {
                            let mut slot = blocked.lock().unwrap();
                            if slot.is_none() {
                                *slot = Some(block);
                            }
                        }
                        Some(CloudReaderAction::CheckedOut) => {
                            checked_out.store(true, Ordering::SeqCst);
                        }
                        None => {}
                    }
                    // `carry` IS the FR-8 window — the same frame-scoped, size-capped
                    // text the matcher just ran against, so publishing it costs no
                    // second buffer and a stall's log shows exactly what was matched.
                    *tail.lock().unwrap() = carry.clone();
                }
            }
        }
        let _ = child.wait();
        exited.store(true, Ordering::SeqCst);
    });
}

/// Writes what teleport actually printed to `<app_data>/cloud-adopt.log`, and
/// names that file in the failure's `detail.logPath`.
///
/// EVERY post-spawn failure goes through here. A `CLOUD_ADOPT_STALLED` carrying
/// only `{ phase }` says the adoption stopped and nothing about why — and the
/// why is always on the PTY: a dialog a CLI release reworded past the FR-8
/// matcher, a checkout that never happened, an error teleport printed and then
/// sat on. Discarding that output is what turns a fixable stall into "it stays
/// on Teleporting and nothing happens".
///
/// `detail` is only ever ADDED to: `phase`, `sessionRepo`/`currentRepo` are what
/// the contract documents and what the UI renders, and they keep their meaning.
fn explain(app: &AppHandle, mut e: AdoptError, pty: &AdoptPty, cloud_id: &str) -> AdoptError {
    let raw = pty.tail.lock().unwrap().clone();
    let seen = normalize_pty(&raw);
    let logged = crate::diagnostics::append_log(
        app,
        ADOPT_LOG,
        &format!(
            "adopt failed cloudId={cloud_id} code={} message={}\n  pty: {}",
            e.code,
            e.message,
            last_chars(&seen, PTY_EXCERPT_CHARS)
        ),
    );
    if let Some(path) = logged {
        let mut detail = e.detail.take().unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = detail.as_object_mut() {
            map.insert("logPath".to_string(), Value::String(path));
        }
        e.detail = Some(detail);
    }
    e
}

// ---------- FR-10: the session the adoption produces ----------

#[allow(clippy::too_many_arguments)]
fn create_adopted_session(
    app: &AppHandle,
    engine: &Engine,
    seed: &crate::project::SessionSeed,
    landing: &Landing,
    runtime: String,
    account_id: String,
    project_id: &str,
    claude_session_id: String,
    cloud_id: &str,
    title: Option<&str>,
) -> String {
    let now = now_ms();
    let id = uuid();
    let model_id = seed
        .model_id
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let permission_mode = seed
        .permission_mode
        .clone()
        .filter(|m| valid_permission_mode(m))
        .unwrap_or_else(|| "default".to_string());
    // multi-provider-seam FR-13: adoption is no exception — the provider is
    // DERIVED from the resolved account's kind here too, never assumed from the
    // fact that the thread came from Claude Code on the web.
    let provider = Provider::from_account_kind(crate::account::kind_of(app, &account_id));
    let mut session = Session::new(
        id.clone(),
        adopt_name(title, &landing.dir),
        landing.dir.clone(),
        model_id.clone(),
        0,
        context_limit(&model_id),
        now,
        now,
        seed.effort.clone().filter(|e| valid_effort(e)),
        permission_mode,
        runtime,
        seed.allow_git.unwrap_or(false),
        Some(project_id.to_string()),
        landing.worktree.clone(),
        landing.distro.clone(),
        account_id,
        provider,
        // FR-10: the LOCAL session teleport hydrated — every later turn resumes
        // this thread over the ordinary `claude --resume` pipeline.
        Some(claude_session_id),
        Vec::new(),
    );
    // FR-10/FR-16: presence is the whole provenance signal. Set here rather than
    // through `Session::new` so no other creation path can accidentally carry it.
    session.cloud = Some(CloudProvenance {
        cloud_session_id: cloud_id.to_string(),
        adopted_at: now,
    });
    let meta = session.meta();
    engine.sessions.lock().unwrap().insert(id.clone(), session);
    persist(app, engine);
    crate::project::touch_last_used(app, project_id);
    emit(app, SessionEvent::Meta { meta });
    crate::diff::watch_session(app, &id, &landing.dir);
    id
}

// ---------- the command ----------

struct AdoptInput<'a> {
    r#ref: &'a str,
    cloud_id: &'a str,
    project_id: &'a str,
    destination: &'a str,
    account_id: Option<&'a str>,
}

/// francois:cloud:adopt — the one-way pull. Resolves with the LOCAL session id,
/// so it runs the whole FR-7 sequence inline (up to the FR-9 deadline) and
/// reports every transition on `francois://cloud/event` as it goes.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn cloud_adopt(
    app: AppHandle,
    engine: State<'_, Engine>,
    reg: State<'_, CloudAdoptRegistry>,
    r#ref: String,
    project_id: String,
    destination: String,
    confirmed: Option<bool>,
    account_id: Option<String>,
) -> IpcResult<CloudAdoptData> {
    // FR-12/FR-3, before ANY work: the destructive landing needs consent, and
    // the ref has to be a cloud session at all.
    let (destination, cloud_id) = match validate_adopt_request(&destination, confirmed, &r#ref) {
        Ok(parts) => parts,
        Err((code, message)) => return err(code, message),
    };
    // §7 #9: not re-entrant. Report the phase the in-flight run has reached
    // rather than spawning a second PTY against the same cloud session.
    if let Some(phase) = reg.phase_of(&r#ref) {
        emit_adopt(&app, &r#ref, &phase);
        return err_detail(
            "INVALID_INPUT",
            ALREADY_MSG,
            serde_json::json!({ "phase": phase_name(&phase) }),
        );
    }

    let slot = Arc::new(Mutex::new(CloudAdoptPhase::Resolving));
    let registry: &CloudAdoptRegistry = &reg;
    if !registry.reserve(&r#ref, slot.clone()) {
        return err("INVALID_INPUT", ALREADY_MSG);
    }
    let mut guard = AdoptGuard::new(registry, r#ref.clone());
    let progress = AdoptProgress::new(app.clone(), r#ref.clone(), slot);
    progress.set(CloudAdoptPhase::Resolving);

    let input = AdoptInput {
        r#ref: &r#ref,
        cloud_id: &cloud_id,
        project_id: &project_id,
        destination: &destination,
        account_id: account_id.as_deref(),
    };
    match run_adoption(&app, &engine, registry, &progress, &mut guard, &input) {
        Ok(session_id) => {
            progress.set(CloudAdoptPhase::Ready {
                session_id: session_id.clone(),
            });
            ok(CloudAdoptData { session_id })
        }
        Err(e) => {
            progress.set(CloudAdoptPhase::Failed {
                error: crate::ipc::AppError {
                    code: e.code.clone(),
                    message: e.message.clone(),
                    detail: e.detail.clone(),
                },
            });
            match e.detail {
                Some(detail) => err_detail(&e.code, e.message, detail),
                None => err(&e.code, e.message),
            }
        }
    }
}

fn run_adoption(
    app: &AppHandle,
    engine: &Engine,
    reg: &CloudAdoptRegistry,
    progress: &AdoptProgress,
    guard: &mut AdoptGuard<'_>,
    input: &AdoptInput<'_>,
) -> Result<String, AdoptError> {
    let Some(seed) = crate::project::session_seed(app, input.project_id) else {
        return Err(AdoptError::new("PROJECT_NOT_FOUND", PROJECT_MSG));
    };
    let runtime = adopt_runtime(seed.runtime.as_deref());

    // FR-1, up front: story 5's "within seconds, not a spinner". The token is
    // not passed to teleport (it authenticates itself) — reading it here is what
    // turns an ineligible account into an actionable refusal before any spawn.
    // multi-account FR-20: an omitted `accountId` falls to the PROJECT's default
    // account before the app-wide one — the adopt modal has no account picker,
    // so the project's own default is what the user configured for this repo.
    let account_id = cloud_account_id(app, input.account_id.or(seed.account_id.as_deref()));
    let config_dir = crate::account::config_dir_of(app, &account_id);
    let token = cloud_access_token(config_dir.as_deref())
        .map_err(|(code, message)| AdoptError::new(code, message))?;

    // FR-3/FR-4: the branch (and the title) the cloud session carries, when the
    // lookup answers. An unhelpful answer is not fatal; an actionable refusal (an
    // untrusted device, an org policy, an unknown id) is — and it lands here,
    // before any git work or any spawn.
    let meta = adopt_meta(lookup_cloud_session(&token, input.cloud_id), input.cloud_id)?;

    progress.set(CloudAdoptPhase::Preparing);
    let mut landing = prepare_landing(
        &seed.root,
        input.destination,
        meta.as_ref().and_then(|m| m.branch.as_deref()),
        input.cloud_id,
    )?;
    // FR-11 arms here and nowhere else: only the branch that actually created a
    // worktree ever fills `created`, so a pre-existing tree can never be removed.
    guard.created = landing.created.take();

    let current_repo = landing.current_repo();
    let claude_id = uuid();
    let (exe, argv) = claude_invocation(
        &runtime,
        &landing.dir,
        teleport_args(input.cloud_id, &claude_id),
        landing.distro.as_deref(),
    );

    progress.set(CloudAdoptPhase::Teleporting);
    let started_at = now_ms();
    let pty = spawn_teleport(
        reg,
        input.r#ref,
        &exe,
        &argv,
        &landing.dir,
        &runtime,
        config_dir.as_deref(),
        current_repo,
        progress.slot(),
    )?;

    let dir = transcript_dir(config_dir.as_deref(), &runtime, &landing.dir);
    // Written BEFORE the wait, not after it: this line is what distinguishes
    // "teleport never hydrated" from "it hydrated somewhere FR-6 was not
    // looking", and it has to survive an adoption the user gives up on.
    crate::diagnostics::append_log(
        app,
        ADOPT_LOG,
        &format!(
            "adopt spawn cloudId={} runtime={runtime} landing={} exe={exe} argv={argv:?} \
             sessionId={claude_id} transcriptDir={}",
            input.cloud_id,
            landing.dir,
            dir.as_ref()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|| "<unresolved>".to_string()),
        ),
    );
    let deadline = Instant::now() + ADOPT_DEADLINE;
    let mut exit_seen: Option<Instant> = None;
    let hydrated = loop {
        // FR-8: a parked dialog fails NOW, with the mapped code — the guard's
        // teardown reaps the child, which would otherwise wait forever for a
        // keypress nobody will send.
        if let Some(block) = pty.blocked.lock().unwrap().clone() {
            return Err(explain(app, block.into(), &pty, input.cloud_id));
        }
        if pty.checked_out.load(Ordering::SeqCst)
            && matches!(progress.current(), CloudAdoptPhase::Teleporting)
        {
            progress.set(CloudAdoptPhase::Hydrating);
        }
        if let Some(id) = dir
            .as_deref()
            .and_then(|d| hydrated_session_id(d, &claude_id, started_at))
        {
            break id;
        }
        if pty.exited.load(Ordering::SeqCst) {
            let since = exit_seen.get_or_insert_with(Instant::now);
            if since.elapsed() >= EXIT_GRACE {
                return Err(explain(
                    app,
                    AdoptError::new("CLOUD_ADOPT_FAILED", EXITED_MSG),
                    &pty,
                    input.cloud_id,
                ));
            }
        }
        if Instant::now() >= deadline {
            let phase = phase_name(&progress.current());
            return Err(explain(
                app,
                AdoptError::detailed(
                    "CLOUD_ADOPT_STALLED",
                    format!(
                        "Adoption did not finish within {}s (it stopped at: {phase}).",
                        ADOPT_DEADLINE.as_secs()
                    ),
                    serde_json::json!({ "phase": phase }),
                ),
                &pty,
                input.cloud_id,
            ));
        }
        std::thread::sleep(ADOPT_POLL);
    };

    // FR-7: `hydrating` is emitted unconditionally before `ready`, so the phase
    // sequence never has a hole even when the checkout marker was never matched.
    if !matches!(progress.current(), CloudAdoptPhase::Hydrating) {
        progress.set(CloudAdoptPhase::Hydrating);
    }
    // FR-10: kill the PTY FIRST — the session about to be created owns this
    // thread from here on, and two live REPLs on one transcript is corruption.
    if let Some(entry) = reg.take(input.r#ref) {
        entry.kill();
    }
    guard.keep = true; // FR-11: the worktree is the session's now.
                       // Closes the pair: a log with a `spawn` and no `hydrated` for the same cloud
                       // id is an adoption the user abandoned or the app outlived.
    crate::diagnostics::append_log(
        app,
        ADOPT_LOG,
        &format!(
            "adopt hydrated cloudId={} claudeSessionId={hydrated} (minted={claude_id})",
            input.cloud_id
        ),
    );
    Ok(create_adopted_session(
        app,
        engine,
        &seed,
        &landing,
        runtime,
        account_id,
        input.project_id,
        hydrated,
        input.cloud_id,
        meta.as_ref().and_then(|m| m.title.as_deref()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- FR-5: the argv ----

    #[test]
    fn teleport_args_are_the_hidden_flag_plus_the_pre_minted_id() {
        assert_eq!(
            teleport_args("session_01AB", "11111111-2222-3333-4444-555555555555"),
            vec![
                "--teleport",
                "session_01AB",
                "--session-id",
                "11111111-2222-3333-4444-555555555555"
            ]
        );
    }

    #[test]
    fn teleport_never_runs_in_print_mode() {
        // `-p` has no checkout and no hydration — a regression that reintroduced
        // it would "succeed" while doing nothing, exactly as Remote Control does.
        let args = teleport_args("session_01AB", "uuid");
        assert!(!args.iter().any(|a| a == "-p" || a == "--print"));
    }

    // ---- the PTY excerpt a failure explains itself with ----

    #[test]
    fn the_excerpt_keeps_the_end_of_the_window_where_the_dialog_is() {
        // The tail of a PTY window is the screen as it stands — the dialog
        // teleport is parked on. The head is the REPL banner, redrawn.
        assert_eq!(last_chars("abcdef", 3), "def");
        assert_eq!(last_chars("abc", 10), "abc");
        assert_eq!(last_chars("", 10), "");
    }

    #[test]
    fn the_excerpt_never_cuts_a_box_drawing_glyph_in_half() {
        // A TUI window is mostly multi-byte glyphs; a byte-wise slice would
        // panic in the very code path a failure runs through.
        let text: String = "─".repeat(50);
        let cut = last_chars(&text, 10);
        assert_eq!(cut.chars().count(), 10);
        assert_eq!(cut, "─".repeat(10));
    }

    // ---- FR-5: the runtime ----

    #[test]
    fn the_runtime_comes_from_the_projects_defaults_and_degrades_safely() {
        assert_eq!(adopt_runtime(None), "native");
        assert_eq!(adopt_runtime(Some("native")), "native");
        assert_eq!(adopt_runtime(Some("bogus")), "native");
        if cfg!(windows) {
            assert_eq!(adopt_runtime(Some("wsl")), "wsl");
        } else {
            assert_eq!(adopt_runtime(Some("wsl")), "native");
        }
    }

    // ---- FR-10: the session's name ----

    #[test]
    fn the_adopted_session_is_named_after_the_cloud_title_when_there_is_one() {
        assert_eq!(
            adopt_name(Some("Fix the flaky auth test"), "/repo/api"),
            "Fix the flaky auth test"
        );
        // No title, an unusable one, or one over the cap → the same basename
        // fallback session_create uses. Never a synthesized "Cloud session".
        assert_eq!(adopt_name(None, "/repo/api"), "api");
        assert_eq!(adopt_name(Some("   "), "/repo/api"), "api");
        assert_eq!(adopt_name(Some(&"x".repeat(200)), "/repo/api"), "api");
        // Control characters are stripped by the shared validator.
        assert_eq!(adopt_name(Some("a\nb"), "/repo/api"), "ab");
    }

    // ---- FR-12 / FR-3: what the command refuses before doing any work ----

    #[test]
    fn a_checkout_landing_without_confirmation_is_refused() {
        // §9: "destination: 'checkout' without confirmed: true is refused with
        // INVALID_INPUT". The core never stashes on the user's behalf — teleport
        // does, and this flag is what makes that consented.
        for confirmed in [None, Some(false)] {
            let (code, message) =
                validate_adopt_request("checkout", confirmed, "session_01AB").unwrap_err();
            assert_eq!(code, "INVALID_INPUT");
            assert!(
                message.contains("stashes") && message.contains("worktree"),
                "the refusal has to say what it would destroy and what to do instead: {message}"
            );
        }
    }

    #[test]
    fn a_confirmed_checkout_and_the_default_worktree_landing_both_pass() {
        assert_eq!(
            validate_adopt_request("checkout", Some(true), "session_01AB").unwrap(),
            ("checkout".to_string(), "session_01AB".to_string())
        );
        // FR-12 applies to the destructive landing ONLY: a worktree needs no
        // confirmation, because it touches nothing that already existed.
        assert_eq!(
            validate_adopt_request(
                " worktree ",
                None,
                "https://claude.ai/code/session_01AB?from=phone"
            )
            .unwrap(),
            ("worktree".to_string(), "session_01AB".to_string())
        );
    }

    #[test]
    fn an_unknown_destination_or_an_unparseable_ref_is_refused() {
        let (code, _) = validate_adopt_request("home", Some(true), "session_01AB").unwrap_err();
        assert_eq!(code, "INVALID_INPUT");
        let (code, message) =
            validate_adopt_request("worktree", None, "https://evil.example/session_01AB")
                .unwrap_err();
        assert_eq!(code, "INVALID_INPUT");
        assert!(message.contains("claude.ai/code"), "actionable: {message}");
    }

    #[test]
    fn the_destructive_landing_is_caught_even_when_the_ref_is_also_bad() {
        // Order matters: an unconfirmed checkout must never be reported as a bad
        // ref, or a retry would "fix" the ref and then stash the user's work.
        let (_, message) = validate_adopt_request("checkout", None, "nonsense").unwrap_err();
        assert!(message.contains("stashes"), "{message}");
    }

    // ---- FR-3 / §2: what the pre-spawn lookup does to an adoption ----

    #[test]
    fn an_unhelpful_lookup_never_stops_an_adoption() {
        // FR-3: teleport does its own validation and FR-4 has a fallback branch
        // name, so a lookup that simply did not answer costs the metadata only.
        assert!(adopt_meta(CloudLookup::Unknown, "session_01AB")
            .expect("adoption continues")
            .is_none());
        let meta = adopt_meta(
            CloudLookup::Found(CloudSession {
                id: "session_01AB".into(),
                branch: Some("fix/flake".into()),
                ..Default::default()
            }),
            "session_01AB",
        )
        .expect("adoption continues")
        .expect("metadata");
        assert_eq!(meta.branch.as_deref(), Some("fix/flake"));
    }

    #[test]
    fn an_actionable_lookup_refusal_fails_the_adoption_before_any_spawn() {
        // §2 Goal: "a named, actionable failure for every documented
        // precondition", and story 5's "within seconds, not a spinner". Both
        // codes are in cloud_adopt's contract union; discarding them here left
        // them unreachable, and the user waiting out the FR-9 deadline for a
        // generic stall instead.
        for (code, message) in [
            ("CLOUD_DEVICE_UNTRUSTED", DEVICE_UNTRUSTED_MSG),
            ("CLOUD_POLICY_DENIED", POLICY_DENIED_MSG),
            ("CLOUD_AUTH_EXPIRED", AUTH_EXPIRED_MSG),
        ] {
            let e = adopt_meta(CloudLookup::Actionable(code, message), "session_01AB")
                .expect_err("must refuse");
            assert_eq!(e.code, code);
            assert_eq!(e.message, message);
        }
        let e = adopt_meta(CloudLookup::NotFound, "session_01AB").expect_err("must refuse");
        assert_eq!(e.code, "CLOUD_SESSION_NOT_FOUND");
        assert!(e.message.contains("session_01AB"), "{}", e.message);
    }

    // ---- FR-13: the hidden-flag canary ----

    /// FR-13: `--teleport` and `--cloud` are `.hideHelp()` on CLI 2.1.222 —
    /// documented on the web, absent from `claude --help`. A surface that can
    /// move without deprecation needs a canary, so this asserts the CLI still
    /// PARSES `claude --teleport <id> --session-id <uuid>`: no "unknown option",
    /// no "cannot be combined".
    ///
    /// Skips (rather than fails) when `claude` is not installed, so CI without
    /// the CLI stays green while every developer machine runs the check. It never
    /// adopts anything: the id is a bogus one, and the child is killed as soon as
    /// the parse verdict is in.
    #[test]
    fn the_teleport_flags_are_still_accepted_by_the_cli() {
        use std::process::{Command, Stdio};

        let mut probe = Command::new("claude");
        probe
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::process_util::no_window(&mut probe);
        if !matches!(probe.status(), Ok(s) if s.success()) {
            eprintln!("FR-13 canary skipped: no `claude` on PATH");
            return;
        }

        let args = teleport_args(
            "session_00000000000000000000000000",
            &uuid::Uuid::new_v4().to_string(),
        );
        let mut cmd = Command::new("claude");
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_util::no_window(&mut cmd);
        let Ok(mut child) = cmd.spawn() else {
            eprintln!("FR-13 canary skipped: could not spawn `claude`");
            return;
        };
        let out = Arc::new(Mutex::new(String::new()));
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let sink = out.clone();
            let mut stream = stream;
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = stream.read_to_string(&mut buf);
                sink.lock().unwrap().push_str(&buf);
            });
        }
        // A parse rejection is instant; anything longer means the flags were
        // accepted and the CLI moved on to real work, which is a pass.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();

        let seen = out.lock().unwrap().to_lowercase();
        for phrase in ["unknown option", "cannot be combined", "unknown argument"] {
            assert!(
                !seen.contains(phrase),
                "the CLI no longer accepts `claude --teleport <id> --session-id <uuid>` \
                 — it said {phrase:?}. cloud-sessions FR-5 needs both flags together.\n{seen}"
            );
        }
    }

    /// LIVE end-to-end check of the one thing unit tests cannot fake: that
    /// `claude --teleport` in a PTY really hydrates a local session where FR-6
    /// looks for it.
    ///
    /// `#[ignore]` because it needs claude.ai auth, network, and a REAL cloud
    /// session. Run with:
    ///   cargo test -- --ignored live_teleport_adopts_a_cloud_session --nocapture
    /// with FRANCOIS_CLOUD_SESSION_ID set to a `session_…` id, and
    /// FRANCOIS_CLOUD_CWD to a checkout of that session's repository.
    #[test]
    #[ignore = "live: needs claude.ai auth + network + a real cloud session"]
    fn live_teleport_adopts_a_cloud_session() {
        let Ok(cloud_id) = std::env::var("FRANCOIS_CLOUD_SESSION_ID") else {
            panic!("set FRANCOIS_CLOUD_SESSION_ID to a claude.ai/code session id");
        };
        let cloud_id = normalize_cloud_ref(&cloud_id).expect("a session_… id or a claude.ai url");
        let cwd = std::env::var("FRANCOIS_CLOUD_CWD").unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string()
        });

        let claude_id = uuid();
        let (exe, argv) =
            claude_invocation("native", &cwd, teleport_args(&cloud_id, &claude_id), None);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(&exe);
        for a in &argv {
            cmd.arg(a);
        }
        cmd.cwd(&cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn claude");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let seen = Arc::new(Mutex::new(String::new()));
        {
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    seen.lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            });
        }

        let started_at = now_ms();
        let dir = transcript_dir(None, "native", &cwd).expect("transcript dir");
        let deadline = Instant::now() + ADOPT_DEADLINE;
        let mut hydrated = None;
        while Instant::now() < deadline {
            hydrated = hydrated_session_id(&dir, &claude_id, started_at);
            if hydrated.is_some() {
                break;
            }
            std::thread::sleep(ADOPT_POLL);
        }
        let _ = child.clone_killer().kill();
        let _ = child.wait();

        let normalized = normalize_pty(&seen.lock().unwrap().clone());
        if hydrated.is_none() {
            if let Some(block) = teleport_block(&normalized, None, "teleporting") {
                panic!("teleport parked, not a code defect: {}", block.message);
            }
            panic!(
                "no local transcript appeared in {}\n{}",
                dir.display(),
                normalized.chars().take(1500).collect::<String>()
            );
        }
        eprintln!("adopted local session {}", hydrated.unwrap());
    }
}

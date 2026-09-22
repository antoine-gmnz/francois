//! claude-process-adapter §6 "product path": the real application entry
//! (`application::start`) over the real native Claude adapter, supervised
//! child, stream decoder, normalized sink/owner reduction, session projection
//! and reply commands. Only the executable is a fixture
//! (`fixtures/fake-claude.cjs`, speaking captured 2.1.228 stream-json): the
//! adapter builds its real argv/env/stdin and the fixture records what it got.
//! No network, no credentials, no model.
use super::{begin_native_turn, turn_args, user_line, ClaudeCodeAdapter};
use crate::ipc::{AppError, ErrorCode};
use crate::permissions::PermissionRule;
use crate::session::application::{self, *};
use crate::session::control::{
    allow_response, allow_tool_response, deny_response, PERMISSION_DENY_MSG,
};
use crate::session::runtime_bridge::{project_runtime_event, EngineState};
use crate::session::testenv::TestEnv;
use crate::session::testutil::{test_engine_with, test_session};
use crate::session::{AgentRuntime, SessionEvent};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SCRIPT: &str = include_str!("fixtures/fake-claude.cjs");
const HOME: &str = "fixture-claude-home";

/// The production adapter with one seam replaced: the executable. Everything
/// else — argv, env, cwd, prompt delivery, reader, TurnHandle — is the real
/// `begin_native_turn` that `ClaudeCodeAdapter::begin_turn` runs.
struct FakeClaude {
    scenario: String,
    record: PathBuf,
    spawns: AtomicUsize,
}
impl FakeClaude {
    fn new(scenario: &str) -> Self {
        Self {
            scenario: scenario.into(),
            record: std::env::temp_dir()
                .join(format!("fake-claude-{}.ndjson", crate::session::uuid())),
            spawns: AtomicUsize::new(0),
        }
    }
    /// Everything the child saw: `{pid, argv, home, cwd}` then one `{stdin}` per line.
    fn record(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.record)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn stdin(&self) -> Vec<Value> {
        self.record()
            .into_iter()
            .filter_map(|entry| entry.get("stdin").cloned())
            .collect()
    }
    fn pid(&self) -> u32 {
        wait(|| self.record().first().and_then(|e| e["pid"].as_u64())) as u32
    }
    fn argv(&self) -> Vec<String> {
        serde_json::from_value(self.record()[0]["argv"].clone()).unwrap()
    }
}
impl Drop for FakeClaude {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.record);
    }
}
impl RuntimePort for FakeClaude {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        ClaudeCodeAdapter.preflight(ctx)
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        begin_native_turn(ctx, sink, |program, argv| {
            assert_eq!(program, "claude", "a native turn launches claude itself");
            let mut node = vec![
                "-e".to_string(),
                SCRIPT.to_string(),
                self.scenario.clone(),
                self.record.to_string_lossy().into_owned(),
            ];
            node.extend(argv);
            ("node".into(), node)
        })
    }
}

/// Production `AppEffects` minus the `AppHandle`: the same session projection,
/// plus a record of terminal effects so a test can wait for the turn to end.
struct Effects {
    env: Arc<TestEnv>,
    terminals: Mutex<Vec<&'static str>>,
    /// The code of every failed turn, in order.
    failures: Mutex<Vec<ErrorCode>>,
}
impl RuntimeEffectPort for Effects {
    fn apply(&self, scope: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
        if let RuntimeEvent::TurnFailed(error) = &event {
            self.failures.lock().unwrap().push(error.code);
        }
        let terminal = match &event {
            RuntimeEvent::TurnFinished => Some("finished"),
            RuntimeEvent::TurnFailed(_) => Some("failed"),
            RuntimeEvent::ConnectionClosed(_) => Some("closed"),
            RuntimeEvent::ResumeRejected => Some("resume-rejected"),
            _ => None,
        };
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let result = project_runtime_event(self.env.as_ref(), &scope.session_id, &cwd, event);
        if let Some(terminal) = terminal {
            self.terminals.lock().unwrap().push(terminal);
        }
        result
    }
}
impl Effects {
    fn wait_terminal(&self) -> Vec<&'static str> {
        wait(|| {
            let terminals = self.terminals.lock().unwrap();
            (!terminals.is_empty()).then(|| terminals.clone())
        })
    }
    /// One terminal outcome, and nothing late behind it.
    fn settled(&self) -> Vec<&'static str> {
        self.wait_terminal();
        std::thread::sleep(Duration::from_millis(250));
        self.terminals.lock().unwrap().clone()
    }
}

/// Rule writes are an Always-only path; this one fails like an unwritable tier.
#[derive(Default)]
struct FailingRules(AtomicUsize);
impl PermissionRulePort for FailingRules {
    fn remember(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: bool,
    ) -> Result<PermissionRule, AppError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(AppError::new(
            ErrorCode::SettingsWriteFailed,
            "fixture tier is read-only",
        ))
    }
}

fn wait<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "expected product effect never arrived"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn events(env: &TestEnv) -> Vec<SessionEvent> {
    env.session_events.lock().unwrap().clone()
}
fn wait_event<T>(env: &TestEnv, pick: impl Fn(&SessionEvent) -> Option<T>) -> T {
    wait(|| env.session_events.lock().unwrap().iter().find_map(&pick))
}
fn wait_asks(env: &TestEnv, session: &str, count: usize) -> Vec<(String, String)> {
    wait(|| {
        let asks: Vec<_> = events(env)
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::PermissionAsked {
                    session_id,
                    block_id,
                    ask,
                    ..
                } if session_id == session => Some((block_id, ask.input_json)),
                _ => None,
            })
            .collect();
        (asks.len() >= count).then_some(asks)
    })
}
fn resolved_permissions(env: &TestEnv) -> Vec<String> {
    events(env)
        .into_iter()
        .filter_map(|event| match event {
            SessionEvent::PermissionResolved { state, .. } => Some(state),
            _ => None,
        })
        .collect()
}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = crate::process_util::spawn("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!(" {pid} "))
    }
    #[cfg(unix)]
    {
        crate::process_util::spawn("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
fn assert_reaped(fake: &FakeClaude) {
    let pid = fake.pid();
    wait(|| (!alive(pid)).then_some(()));
}

fn session(id: &str, anchor: Option<&str>) -> crate::session::Session {
    let mut session = test_session();
    session.id = id.into();
    session.agent_runtime = AgentRuntime::ClaudeCode;
    session.status = "starting".into();
    session.runtime = "native".into();
    session.cwd = std::env::temp_dir().to_string_lossy().into_owned();
    session.claude_session_id = anchor.map(String::from);
    session
}
fn setup(anchor: Option<&str>) -> (Arc<TestEnv>, Arc<Effects>) {
    let env = Arc::new(TestEnv {
        engine: test_engine_with(session("s1", anchor)),
        ..Default::default()
    });
    let effects = Arc::new(Effects {
        env: env.clone(),
        terminals: Mutex::new(vec![]),
        failures: Mutex::new(vec![]),
    });
    (env, effects)
}
/// What `runtime_bridge::start_runtime` resolves before `application::start`.
fn context(env: &TestEnv, id: &str) -> TurnContext {
    let mut ctx = crate::session::turn::build_turn_context(
        &env.engine,
        id,
        "user-block".into(),
        "fixture prompt".into(),
        TurnMode::Normal,
    )
    .unwrap();
    ctx.execution.identity = ExecutionIdentity {
        account_id: ctx.account_id.clone(),
        home: Some(HOME.into()),
        runtime: ctx.runtime.clone(),
        worktree_distro: None,
    };
    ctx.execution.environment = vec![("CLAUDE_CONFIG_DIR".into(), HOME.into())];
    ctx.execution.account_authenticated = true;
    ctx
}
fn start(env: &TestEnv, effects: &Arc<Effects>, fake: &FakeClaude, id: &str) {
    application::start(
        &EngineState(&env.engine),
        fake,
        effects.clone(),
        context(env, id),
    )
    .unwrap();
}
fn anchor(env: &TestEnv) -> Option<String> {
    env.engine
        .with_session("s1", |s| s.claude_session_id.clone())
        .flatten()
}

#[test]
fn text_turn_keeps_the_claude_protocol_and_projects_parent_context_usage() {
    let fake = FakeClaude::new("text");
    let (env, effects) = setup(None);
    let ctx = context(&env, "s1");
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["finished"]);

    // FR-2: exactly the pre-migration argv — no positional prompt, same flags.
    let argv = fake.argv();
    assert_eq!(
        argv,
        turn_args(
            &ctx.model_id,
            None,
            ctx.effort.as_deref(),
            &ctx.permission_mode,
            None,
            &[],
            ctx.response_mode,
        )
    );
    assert_eq!(argv[0], "-p");
    assert!(!argv.iter().any(|a| a.contains("fixture prompt")));
    // The account home rides the environment; the prompt rides stdin, once.
    assert_eq!(fake.record()[0]["home"], HOME);
    let prompt: Value = serde_json::from_str(user_line("fixture prompt").trim_end()).unwrap();
    assert_eq!(fake.stdin(), vec![prompt]);

    let events = events(&env);
    assert!(events
        .iter()
        .any(|e| matches!(e, SessionEvent::Status { status, .. } if status == "running")));
    let streamed: String = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::AssistantDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "hello from fake claude");
    assert!(events.iter().any(|e| matches!(e,
        SessionEvent::AssistantDone { text, .. } if text == "hello from fake claude")));
    // FR-3: the last parent request (2 + 40000 + 500), never the 3.4M result aggregate.
    let used = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::ContextUsage { used_tokens, .. } => Some(*used_tokens),
            _ => None,
        })
        .next_back();
    assert_eq!(used, Some(40_502));
    // The native thread id is committed as the resume anchor.
    assert_eq!(anchor(&env).as_deref(), Some("fresh-claude-thread"));
    // Post-result EOF: stdin closed, the CLI exited, the child was reaped.
    assert_reaped(&fake);
}

#[test]
fn tool_use_and_result_project_as_one_settled_tool_block() {
    let fake = FakeClaude::new("tool");
    let (env, effects) = setup(None);
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["finished"]);
    let events = events(&env);
    let started = events
        .iter()
        .find_map(|e| match e {
            SessionEvent::ToolStart { block_id, tool, .. } if tool == "Read" => {
                Some(block_id.clone())
            }
            _ => None,
        })
        .expect("Read tool block started");
    assert!(events
        .iter()
        .any(|e| matches!(e, SessionEvent::ToolDone { block_id, .. } if *block_id == started)));
    assert!(!started.contains("toolu_read"), "native ids stay private");
    let used = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::ContextUsage { used_tokens, .. } => Some(*used_tokens),
            _ => None,
        })
        .next_back();
    assert_eq!(used, Some(41_022));
    assert_reaped(&fake);
}

#[test]
fn permission_allow_and_deny_write_exactly_once_with_the_original_input() {
    let fake = FakeClaude::new("permission");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &fake, "s1");
    let asks = wait_asks(&env, "s1", 2);
    let block = |needle: &str| {
        asks.iter()
            .find(|(_, input)| input.contains(needle))
            .map(|(id, _)| id.clone())
            .unwrap()
    };
    let (allow, deny) = (block("mkdir build"), block("rmdir build"));
    assert!(!allow.contains("req-") && !deny.contains("req-"));
    let rules = FailingRules::default();
    let decide = |id: &str, decision, remember| {
        application::decide_permission(
            &state,
            effects.as_ref(),
            &rules,
            "s1",
            id,
            decision,
            remember,
            None,
        )
    };
    // FR-4 rule-first: a failed Always writes nothing and leaves the ask live.
    assert_eq!(
        decide(&allow, PermissionDecision::Allow, true)
            .unwrap_err()
            .code,
        ErrorCode::SettingsWriteFailed
    );
    assert_eq!(rules.0.load(Ordering::SeqCst), 1);
    assert!(fake.stdin().len() == 1, "a failed rule write reached stdin");
    decide(&allow, PermissionDecision::Allow, false).unwrap();
    assert_eq!(
        decide(&allow, PermissionDecision::Allow, false)
            .unwrap_err()
            .code,
        ErrorCode::PermissionNotPending
    );
    decide(&deny, PermissionDecision::Deny, false).unwrap();
    assert_eq!(effects.settled(), vec!["finished"]);

    let input = |command: &str, description: &str| json!({ "command": command, "description": description });
    assert_eq!(
        fake.stdin()[1..],
        [
            allow_tool_response(
                "req-allow",
                &input("mkdir build", "Create a build directory")
            ),
            deny_response("req-deny", PERMISSION_DENY_MSG),
        ]
    );
    assert_eq!(resolved_permissions(&env), vec!["allowed", "denied"]);
    assert_reaped(&fake);
}

#[test]
fn question_answer_reaches_claude_verbatim_once() {
    let fake = FakeClaude::new("question");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &fake, "s1");
    let block = wait_event(&env, |e| match e {
        SessionEvent::QuestionAsked { block_id, .. } => Some(block_id.clone()),
        _ => None,
    });
    let answers = json!({ "Which environment?": "staging" });
    application::answer_question(&state, effects.as_ref(), "s1", &block, &answers).unwrap();
    assert_eq!(
        application::answer_question(&state, effects.as_ref(), "s1", &block, &answers)
            .unwrap_err()
            .code,
        ErrorCode::QuestionNotPending
    );
    assert_eq!(effects.settled(), vec!["finished"]);
    let original = json!({ "questions": [{ "question": "Which environment?",
        "header": "Environment", "options": [
            { "label": "staging", "description": "the staging environment" },
            { "label": "production", "description": "the production environment" }],
        "multiSelect": false }] });
    assert_eq!(
        fake.stdin()[1..],
        [allow_response("req-question", &original, &answers)]
    );
    // Codex's secret redaction never reaches a Claude answer.
    let resolved = wait_event(&env, |e| match e {
        SessionEvent::QuestionResolved { answers, state, .. } if state == "answered" => {
            answers.clone()
        }
        _ => None,
    });
    assert_eq!(resolved, answers);
    assert_reaped(&fake);
}

#[test]
fn interrupt_ends_the_turn_once_and_reaps_the_child() {
    let fake = FakeClaude::new("hang");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &fake, "s1");
    wait_event(&env, |e| {
        matches!(
            e,
            SessionEvent::AssistantDone { .. } | SessionEvent::AssistantDelta { .. }
        )
        .then_some(())
    });
    let asked = Instant::now();
    application::interrupt(&state, "s1").unwrap();
    application::interrupt(&state, "s1").unwrap();
    assert!(
        asked.elapsed() < Duration::from_millis(1500),
        "stop waited on a grace period"
    );
    assert_eq!(effects.settled(), vec!["finished"]);
    assert_eq!(fake.stdin().len(), 1, "interrupt writes nothing to stdin");
    assert_reaped(&fake);
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1);
}

#[test]
fn close_cancels_the_parked_ask_once_and_late_eof_adds_no_outcome() {
    let fake = FakeClaude::new("park");
    let (env, effects) = setup(None);
    let state = EngineState(&env.engine);
    start(&env, &effects, &fake, "s1");
    let (block, _) = wait_asks(&env, "s1", 1).remove(0);
    application::close(&state, effects.as_ref(), "s1").unwrap();
    application::close(&state, effects.as_ref(), "s1").unwrap();
    assert_reaped(&fake);
    std::thread::sleep(Duration::from_millis(250)); // room for a late EOF outcome
    assert_eq!(resolved_permissions(&env), vec!["cancelled"]);
    assert!(effects.terminals.lock().unwrap().is_empty());
    // A historical card can never claim the dead turn's channel.
    assert_eq!(
        application::decide_permission(
            &state,
            effects.as_ref(),
            &FailingRules::default(),
            "s1",
            &block,
            PermissionDecision::Allow,
            false,
            None,
        )
        .unwrap_err()
        .code,
        ErrorCode::PermissionNotPending
    );
    assert_eq!(fake.stdin().len(), 1);
}

#[test]
fn two_live_scopes_cannot_answer_each_others_asks() {
    let (one, two) = (FakeClaude::new("park"), FakeClaude::new("park"));
    let (env, effects) = setup(None);
    env.engine
        .sessions
        .lock()
        .unwrap()
        .insert("s2".into(), session("s2", None));
    let state = EngineState(&env.engine);
    start(&env, &effects, &one, "s1");
    start(&env, &effects, &two, "s2");
    let (first, _) = wait_asks(&env, "s1", 1).remove(0);
    let (second, _) = wait_asks(&env, "s2", 1).remove(0);
    let decide = |session: &str, block: &str| {
        application::decide_permission(
            &state,
            effects.as_ref(),
            &FailingRules::default(),
            session,
            block,
            PermissionDecision::Allow,
            false,
            None,
        )
    };
    assert_eq!(
        decide("s2", &first).unwrap_err().code,
        ErrorCode::PermissionNotPending
    );
    assert_eq!(
        decide("s1", &second).unwrap_err().code,
        ErrorCode::PermissionNotPending
    );
    decide("s1", &first).unwrap();
    wait(|| (one.stdin().len() == 2).then_some(()));
    assert_eq!(two.stdin().len(), 1, "the other scope's child got a write");
    application::close(&state, effects.as_ref(), "s1").unwrap();
    application::close(&state, effects.as_ref(), "s2").unwrap();
    assert_reaped(&one);
    assert_reaped(&two);
}

#[test]
fn a_crashed_child_fails_the_turn_once() {
    let fake = FakeClaude::new("crash");
    let (_env, effects) = setup(None);
    start(&_env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["failed"]);
    assert_reaped(&fake);
}

#[test]
fn a_saved_anchor_resumes_the_same_claude_thread() {
    let fake = FakeClaude::new("resume");
    let (env, effects) = setup(Some("saved-thread"));
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["finished"]);
    let argv = fake.argv();
    assert!(argv
        .windows(2)
        .any(|pair| pair[0] == "--resume" && pair[1] == "saved-thread"));
    assert_eq!(anchor(&env).as_deref(), Some("saved-thread"));
}

#[test]
fn a_rejected_resume_is_explicit_and_keeps_the_saved_anchor() {
    let fake = FakeClaude::new("resume-rejected");
    let (env, effects) = setup(Some("stale-thread"));
    start(&env, &effects, &fake, "s1");
    assert_eq!(effects.settled(), vec!["resume-rejected"]);
    let events = events(&env);
    assert!(events
        .iter()
        .any(|e| matches!(e, SessionEvent::ResumeFailed { .. })));
    assert!(!events
        .iter()
        .any(|e| matches!(e, SessionEvent::AssistantDelta { .. })));
    // Nothing retries fresh (process-session-continuity FR-5): the projection
    // fails the turn explicitly, and the adapter neither respawns nor drops the anchor.
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(anchor(&env).as_deref(), Some("stale-thread"));
    assert_reaped(&fake);
}

#[test]
fn golden_capture_projects_equivalently_through_the_product_path() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/session/stream/fixtures/turn.ndjson"
    );
    let fake = FakeClaude::new(&format!("golden:{path}"));
    let (env, effects) = setup(None);
    start(&env, &effects, &fake, "s1");
    effects.settled();
    let raw: Vec<Value> = events(&env)
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let actual = crate::session::stream::golden_replay_tests::normalize(&raw);

    // The locked sequence was produced by the decoder alone. The product path
    // adds exactly what the pre-migration reader added around it with a live
    // turn handle: the derived parked status when the approval parks (and no
    // `running` flash while the turn-end drain cancels), then the turn's
    // parent-request context figure before the terminal outcome.
    let mut expected: Vec<Value> =
        serde_json::from_str(include_str!("../../stream/fixtures/turn.expected.json")).unwrap();
    let asked = expected
        .iter()
        .position(|e| e["type"] == "permission.asked")
        .unwrap();
    // The fixture session lives at `/x`; the product session needs a real cwd to spawn in.
    expected[asked]["ask"]["cwd"] = json!(std::env::temp_dir().to_string_lossy());
    expected.insert(
        asked + 1,
        json!({"type": "session.status", "sessionId": "s1", "status": "awaiting_approval"}),
    );
    let used = {
        let replay = TestEnv {
            engine: test_engine_with(session("s1", None)),
            ..Default::default()
        };
        crate::session::stream::parse_stream(
            &replay,
            "s1",
            std::io::Cursor::new(std::fs::read(path).unwrap()),
            &Arc::new(Mutex::new(None)),
            &Arc::new(Mutex::new(Default::default())),
            &Arc::new(Mutex::new(Default::default())),
            None,
        )
        .ctx_usage
        .finish(0)
        .unwrap()
    };
    let limit = env
        .engine
        .with_session("s1", |s| s.context_limit_tokens)
        .unwrap();
    expected.push(json!({"type": "context.usage", "sessionId": "s1",
        "usedTokens": used.min(limit), "limitTokens": limit}));
    assert_eq!(
        actual.len(),
        expected.len(),
        "{}",
        serde_json::to_string_pretty(&actual).unwrap()
    );
    for (i, (actual, want)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(
            actual, want,
            "event #{i} diverged from the golden projection"
        );
    }
    // The capture's two asks were answered live; replayed, they end parked and
    // the turn settles once, without writing anything past the prompt.
    assert_eq!(fake.stdin().len(), 1);
    assert_reaped(&fake);
}

mod continuity_tests;

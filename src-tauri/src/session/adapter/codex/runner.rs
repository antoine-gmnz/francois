//! Shared Codex transcript and command-detail normalization.
use super::translate::{Effect, ToolCapture, Translator};
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::{RuntimeEvent, TurnContext};
#[cfg(test)]
use crate::session::StepBody;
use crate::session::{build_step_detail, StepDetail};

fn codex_step_detail(block_id: &str, cap: &ToolCapture, cwd: &str, runtime: &str) -> StepDetail {
    build_step_detail(
        block_id,
        &cap.tool,
        cwd,
        runtime,
        cap.started_at,
        cap.ended_at,
        cap.is_error,
        cap.exit_code,
        &cap.input,
        &cap.output,
        None, // FR-6: Codex does not separate stdout/stderr
    )
}

pub(super) fn normalize<F: FnMut() -> String>(
    translator: &mut Translator<F>,
    effect: Effect,
    ctx: &TurnContext,
) -> RuntimeEvent {
    match effect {
        Effect::Anchor(anchor) => RuntimeEvent::ResumeAnchor(anchor),
        Effect::Assistant { block_id, text } => RuntimeEvent::AssistantFinal { block_id, text },
        Effect::ToolStart {
            block_id,
            tool,
            summary,
        } => RuntimeEvent::ToolStarted {
            block_id,
            tool,
            summary,
        },
        Effect::ToolDone {
            block_id,
            tool,
            meta,
        } => {
            let detail = translator
                .take_capture(&block_id)
                .map(|capture| codex_step_detail(&block_id, &capture, &ctx.cwd, &ctx.runtime));
            RuntimeEvent::ToolCompleted {
                block_id,
                meta,
                detail,
                affects_workspace: tool == "Edit",
            }
        }
        Effect::Usage(used) => RuntimeEvent::Usage {
            context_used_tokens: Some(used),
            input_tokens: None,
            output_tokens: None,
            cost: None,
        },
        Effect::Failed(message) => {
            RuntimeEvent::TurnFailed(AppError::new(ErrorCode::Internal, message))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- codex_step_detail (command-inspect FR-1/FR-9) ----------

    #[test]
    fn a_settled_capture_becomes_a_field_exact_step_detail() {
        let cap = ToolCapture {
            tool: "Bash".to_string(),
            started_at: 100,
            ended_at: 200,
            input: json!({ "command": "npm test" }),
            output: "14 failed\n".to_string(),
            exit_code: Some(1),
            is_error: true,
        };
        let d = codex_step_detail("b1", &cap, "/repo", "native");
        assert_eq!(d.block_id, "b1");
        assert_eq!(d.tool, "Bash");
        assert_eq!(d.cwd, "/repo");
        assert_eq!(d.runtime, "native");
        assert_eq!(d.started_at, 100);
        assert_eq!(d.ended_at, Some(200));
        assert!(d.is_error);
        assert_eq!(d.exit_code, Some(1));
        match d.body {
            StepBody::Command { command, output } => {
                assert_eq!(command.command, "npm test");
                assert_eq!(output.text, "14 failed\n");
                assert_eq!(output.stderr_lines, None); // FR-6: Codex never splits streams
            }
            other => panic!("expected a command body, got {other:?}"),
        }
    }

    #[test]
    fn a_non_bash_capture_becomes_a_generic_step_detail() {
        let cap = ToolCapture {
            tool: "Read".to_string(),
            started_at: 0,
            ended_at: 1,
            input: json!({ "file_path": "src/x.ts" }),
            output: String::new(),
            exit_code: None,
            is_error: false,
        };
        let d = codex_step_detail("b2", &cap, "/repo", "native");
        assert_eq!(d.tool, "Read");
        assert!(!d.is_error);
        assert_eq!(d.exit_code, None);
        match d.body {
            StepBody::Generic { input_json, .. } => {
                assert!(input_json.contains("src/x.ts"));
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
    }

    /// process-runtime-events AC-1/AC-4: the captured `codex exec --json` turn,
    /// through the production sink (`apply_event`) into the real projection,
    /// yields the public blocks, resume anchor, context and detail effects.
    #[test]
    fn the_captured_exec_turn_projects_through_the_production_sink() {
        use crate::session::application::*;
        use crate::session::testenv::TestEnv;
        use crate::session::testutil::{test_engine_with, test_session};
        use crate::session::SessionEvent;
        struct Projection<'a>(&'a TestEnv);
        impl RuntimeEffectPort for Projection<'_> {
            fn apply(&self, _: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError> {
                crate::session::runtime_bridge::project_runtime_event(self.0, "s1", "/repo", event)
            }
        }
        let env = TestEnv {
            engine: test_engine_with(test_session()),
            ..Default::default()
        };
        let scope = RuntimeScope {
            session_id: "s1".into(),
            turn_id: "t".into(),
            generation: 1,
        };
        let ctx = TurnContext {
            session_id: "s1".into(),
            block_id: "t".into(),
            text: "ls".into(),
            mode: TurnMode::Normal,
            cwd: "/repo".into(),
            model_id: "gpt".into(),
            effort: None,
            permission_mode: "default".into(),
            runtime: "native".into(),
            worktree_distro: None,
            account_id: "a".into(),
            allow_git: false,
            resume: None,
            system_prompt: None,
            extra_args: vec![],
            response_mode: crate::session::response_mode::ResponseMode::Default,
            scope: scope.clone(),
            execution: ExecutionConfig::default(),
        };
        let owner = RuntimeOwner::new(scope.clone());
        let mut translator = Translator::new({
            let mut n = 0;
            move || {
                n += 1;
                format!("b{n}")
            }
        });
        let mut effects: Vec<Effect> = include_str!("fixtures/exec_turn.jsonl")
            .lines()
            .flat_map(|l| translator.on_event(super::super::wire::parse_line(l)))
            .collect();
        effects.extend(translator.close_open());
        for (i, effect) in effects.into_iter().enumerate() {
            let event = normalize(&mut translator, effect, &ctx);
            let envelope = RuntimeEventEnvelope {
                scope: scope.clone(),
                sequence: i as u64 + 1,
                event,
            };
            assert_eq!(
                apply_event(&owner, &Projection(&env), envelope).unwrap(),
                ApplyOutcome::Applied
            );
        }
        let kinds: Vec<String> = env
            .session_events
            .lock()
            .unwrap()
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "assistant.done",
                "tool.start",
                "tool.done",
                "assistant.done",
                "context.usage"
            ]
        );
        assert!(env.session_events.lock().unwrap().iter().any(|e| matches!(
            e,
            SessionEvent::ToolDone {
                has_detail: Some(true),
                ..
            }
        )));
        assert_eq!(env.step_details.lock().unwrap().len(), 1);
        assert!(
            env.diff_notes.lock().unwrap().is_empty(),
            "a Bash command is not a workspace edit"
        );
        env.engine.with_session("s1", |s| {
            assert_eq!(
                s.claude_session_id.as_deref(),
                Some("01a00f3d-6d04-73d3-96e0-00edad63ce9d")
            );
            assert_eq!(s.context_used_tokens, 27022 + 19968 + 114);
        });
    }
}

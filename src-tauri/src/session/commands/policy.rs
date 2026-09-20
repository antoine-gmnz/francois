//! session/commands/policy.rs — francois:session:acknowledgePolicy
//! (pi-skills-capabilities FR-5). LEAD ADDITION — see contract/
//! session-engine.ts's own comment on `RuntimePolicyAcknowledgeInput`: the
//! spec requires the core to refuse the first submit while
//! `acknowledgedUnrestrictedTools` is false, but names no verb that records
//! the acknowledgment AFTER creation. This is that verb.

use crate::ipc::{err, ok, ErrorCode, IpcResult};
use crate::session::*;
use serde_json::Value;
use tauri::{AppHandle, State};

/// Pure: flips ONLY `acknowledged_unrestricted_tools`; every other policy
/// field (`projectResources`, `extensions`) is untouched, and this never
/// becomes an allow/deny tool rule. No-op (never a panic) on a session with
/// no policy at all — defensive; `session_create` always seeds one for a
/// Pi account.
pub(crate) fn acknowledge_resource_policy(session: &mut Session) {
    if let Some(policy) = session.resource_policy.as_mut() {
        policy.acknowledged_unrestricted_tools = true;
    }
}

/// invoke('session_acknowledge_policy', { sessionId }): Promise<Result<SessionMeta>>
/// Idempotent. Errors: SESSION_NOT_FOUND, RUNTIME_UNSUPPORTED (not a Pi
/// session), INTERNAL.
#[tauri::command(async)]
pub fn session_acknowledge_policy(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Value> {
    match engine.with_session(&session_id, |s| s.agent_runtime) {
        None => return err(ErrorCode::SessionNotFound, "no such session"),
        Some(AgentRuntime::Pi) => {}
        Some(_) => {
            return err(
                ErrorCode::RuntimeUnsupported,
                "this session's runtime has no unrestricted-tools acknowledgment to record",
            )
        }
    }
    let Some(meta) = engine.with_session_mut(&session_id, |s| {
        acknowledge_resource_policy(s);
        s.meta(&app)
    }) else {
        return err(ErrorCode::SessionNotFound, "no such session");
    };
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

// No unit test for the Tauri command wrapper itself: this crate wires up no
// `AppHandle` test harness (same constraint `submit.rs`'s own doc names).
// The meaningful logic — `acknowledge_resource_policy` — is pure and tested
// directly below.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::pi::{ExtensionsPolicy, ProjectResources, RuntimeResourcePolicy};
    use crate::session::testutil::test_session;

    #[test]
    fn acknowledge_resource_policy_flips_only_the_acknowledgment() {
        let mut s = test_session();
        s.resource_policy = Some(RuntimeResourcePolicy {
            project_resources: ProjectResources::Ignore,
            extensions: ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: false,
        });
        acknowledge_resource_policy(&mut s);
        let policy = s.resource_policy.unwrap();
        assert!(policy.acknowledged_unrestricted_tools);
        assert_eq!(policy.project_resources, ProjectResources::Ignore);
        assert_eq!(policy.extensions, ExtensionsPolicy::Disabled);
    }

    #[test]
    fn acknowledge_resource_policy_is_idempotent() {
        let mut s = test_session();
        s.resource_policy = Some(RuntimeResourcePolicy {
            project_resources: ProjectResources::Allow,
            extensions: ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: true,
        });
        acknowledge_resource_policy(&mut s);
        acknowledge_resource_policy(&mut s);
        assert!(s.resource_policy.unwrap().acknowledged_unrestricted_tools);
    }

    #[test]
    fn acknowledge_resource_policy_is_a_noop_without_a_policy_at_all() {
        let mut s = test_session();
        s.resource_policy = None;
        acknowledge_resource_policy(&mut s); // must not panic
        assert!(s.resource_policy.is_none());
    }
}

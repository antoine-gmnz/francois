//! Native request encoding. Reuses the existing permission-to-sandbox policy.
use super::super::args::{sandbox_for, Sandbox};
use super::protocol::{request, ProtocolError, RequestId};
use serde_json::{json, Value};

pub(super) struct NativeSettings<'a> {
    pub cwd: &'a str,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub permission_mode: &'a str,
}
impl NativeSettings<'_> {
    fn approval_policy(&self) -> &'static str {
        if sandbox_for(self.permission_mode) == Sandbox::DangerFullAccess {
            "never"
        } else {
            "on-request"
        }
    }
    fn sandbox_policy(&self) -> Value {
        match sandbox_for(self.permission_mode) {
            Sandbox::ReadOnly => json!({"type":"readOnly","networkAccess":false}),
            Sandbox::WorkspaceWrite => {
                json!({"type":"workspaceWrite","writableRoots":[self.cwd],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
            }
            Sandbox::DangerFullAccess => json!({"type":"dangerFullAccess"}),
        }
    }
    pub(super) fn thread_request(
        &self,
        id: &RequestId,
        resume: Option<&str>,
    ) -> Result<Value, ProtocolError> {
        let mut params = json!({"cwd":self.cwd,"model":self.model,"sandbox":sandbox_for(self.permission_mode).as_str(),"approvalPolicy":self.approval_policy(),"approvalsReviewer":"user"});
        let method = match resume {
            Some(anchor) => {
                if anchor.is_empty() {
                    return Err(ProtocolError::MalformedEnvelope);
                }
                params["threadId"] = json!(anchor);
                params["excludeTurns"] = json!(true);
                "thread/resume"
            }
            None => {
                params["allowProviderModelFallback"] = json!(false);
                "thread/start"
            }
        };
        Ok(request(id, method, params))
    }
    pub(super) fn turn_request(
        &self,
        id: &RequestId,
        thread: &str,
        text: &str,
        local_images: &[String],
    ) -> Result<Value, ProtocolError> {
        if thread.is_empty() {
            return Err(ProtocolError::MalformedEnvelope);
        }
        let mut input = vec![json!({"type":"text","text":text,"text_elements":[]})];
        input.extend(
            local_images
                .iter()
                .map(|path| json!({"type":"localImage","path":path})),
        );
        let mut params = json!({"threadId":thread,"input":input,"cwd":self.cwd,"model":self.model,"sandboxPolicy":self.sandbox_policy(),"approvalPolicy":self.approval_policy(),"approvalsReviewer":"user"});
        if let Some(effort) = self.effort {
            params["effort"] = json!(effort);
        }
        Ok(request(id, "turn/start", params))
    }
}

/// No native-history import/path override and no fallback to thread/start on
/// error. A resume readback must name the exact requested opaque thread.
pub(super) fn returned_thread(
    result: &Value,
    expected: Option<&str>,
) -> Result<String, ProtocolError> {
    let thread = result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(ProtocolError::MalformedEnvelope)?;
    if expected.is_some_and(|expected| expected != thread) {
        return Err(ProtocolError::MalformedEnvelope);
    }
    Ok(thread.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings(mode: &str) -> NativeSettings<'_> {
        NativeSettings {
            cwd: "/repo",
            model: "chosen-model",
            effort: Some("low"),
            permission_mode: mode,
        }
    }
    #[test]
    fn resume_uses_only_exact_anchor_and_never_history_or_path() {
        let wire = settings("default")
            .thread_request(&RequestId::Integer(1), Some("exec-opaque-thread"))
            .unwrap();
        assert_eq!(wire["method"], "thread/resume");
        assert_eq!(wire["params"]["threadId"], "exec-opaque-thread");
        assert!(wire["params"].get("history").is_none());
        assert!(wire["params"].get("path").is_none());
        assert_eq!(
            returned_thread(
                &json!({"thread":{"id":"exec-opaque-thread"}}),
                Some("exec-opaque-thread")
            ),
            Ok("exec-opaque-thread".into())
        );
        assert!(returned_thread(
            &json!({"thread":{"id":"fresh-thread"}}),
            Some("exec-opaque-thread")
        )
        .is_err());
        assert!(settings("default")
            .thread_request(&RequestId::Integer(1), Some(""))
            .is_err());
    }
    #[test]
    fn new_thread_never_allows_provider_model_fallback() {
        let wire = settings("default")
            .thread_request(&RequestId::Integer(1), None)
            .unwrap();
        assert_eq!(wire["method"], "thread/start");
        assert_eq!(wire["params"]["allowProviderModelFallback"], false);
        assert!(wire["params"].get("threadId").is_none());
    }
    #[test]
    fn immutable_turn_encodes_native_text_images_model_effort_and_sandbox() {
        for (mode, sandbox, policy) in [
            ("default", "readOnly", "on-request"),
            ("plan", "readOnly", "on-request"),
            ("acceptEdits", "workspaceWrite", "on-request"),
            ("bypassPermissions", "dangerFullAccess", "never"),
        ] {
            let wire = settings(mode)
                .turn_request(
                    &RequestId::Integer(2),
                    "thread",
                    "literal $() prompt",
                    &["/repo/image.png".into()],
                )
                .unwrap();
            assert_eq!(wire["params"]["sandboxPolicy"]["type"], sandbox);
            assert_eq!(wire["params"]["approvalPolicy"], policy);
            assert_eq!(
                wire["params"]["input"],
                json!([{"type":"text","text":"literal $() prompt","text_elements":[]},{"type":"localImage","path":"/repo/image.png"}])
            );
            assert_eq!(wire["params"]["model"], "chosen-model");
            assert_eq!(wire["params"]["effort"], "low");
        }
    }
}

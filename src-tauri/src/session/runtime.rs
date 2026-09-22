//! Availability and capability enforcement at the session boundary.
use super::*;
impl Engine {
    pub(crate) fn ensure_available(&self, id: &str) -> Result<(), AppError> {
        if self
            .retired_runtime_records
            .lock()
            .unwrap()
            .contains_key(id)
        {
            return Err(crate::ipc::retired_pi_error());
        }
        if self
            .unsupported_runtime_records
            .lock()
            .unwrap()
            .contains_key(id)
        {
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                "unsupported runtime record retained for recovery",
            ));
        }
        match self.with_session(id, |s| s.agent_runtime) {
            None => Err(AppError::new(ErrorCode::SessionNotFound, "no such session")),
            Some(AgentRuntime::Pi) => Err(crate::ipc::retired_pi_error()),
            Some(_) => Ok(()),
        }
    }
    pub(crate) fn require_capability(
        &self,
        id: &str,
        key: &str,
    ) -> Result<(), (ErrorCode, &'static str)> {
        if let Err(e) = self.ensure_available(id) {
            return Err((
                e.code,
                if e.code == ErrorCode::SessionNotFound {
                    "no such session"
                } else {
                    "Pi is unavailable in this version. Saved history is read-only."
                },
            ));
        }
        self.with_session(id, |s| s.check_capability(key))
            .unwrap_or(Err((ErrorCode::SessionNotFound, "no such session")))
    }
}

impl Session {
    /// process-native-capabilities FR-4/FR-6: the session's capability under
    /// its CURRENT live snapshot + generation. Every backend guard reads this.
    pub(crate) fn check_capability(&self, key: &str) -> Result<(), (ErrorCode, &'static str)> {
        adapter::check_capability(
            self.agent_runtime,
            self.effective_capabilities.as_ref(),
            self.runtime_generation.as_deref(),
            key,
        )
    }
}

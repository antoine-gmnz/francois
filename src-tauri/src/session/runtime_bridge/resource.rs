use super::*;

impl EngineState<'_> {
    pub(super) fn session_runtime(
        &self,
        id: &str,
        identity: &ExecutionIdentity,
        candidate: Arc<dyn SessionRuntime>,
    ) -> Result<Arc<dyn SessionRuntime>, AppError> {
        let result = (|| {
            let gate = self.gate(id)?;
            let _guard = gate.lock().unwrap();
            self.0.with_session_mut(id, |session| {
                if let Some(binding) = &session.session_runtime {
                    if binding.identity != *identity {
                        return Err(AppError::new(ErrorCode::RuntimeUnavailable,
                            "The native connection belongs to a different account or execution environment. Start a new session."));
                    }
                    return Ok(binding.runtime.clone());
                }
                session.session_runtime = Some(SessionRuntimeBinding {
                    identity: identity.clone(), runtime: candidate.clone(),
                });
                Ok(candidate.clone())
            }).ok_or_else(|| AppError::new(ErrorCode::SessionNotFound,"no such session"))?
        })();
        if !result
            .as_ref()
            .is_ok_and(|runtime| Arc::ptr_eq(runtime, &candidate))
        {
            candidate.close();
        }
        result
    }
    pub(super) fn take_session_runtime(
        &self,
        id: &str,
    ) -> Result<Option<Arc<dyn SessionRuntime>>, AppError> {
        let gate = self.gate(id)?;
        let _guard = gate.lock().unwrap();
        self.0
            .with_session_mut(id, |session| {
                session.runtime_generation = None;
                session.effective_capabilities = None;
                session
                    .session_runtime
                    .take()
                    .map(|binding| binding.runtime)
            })
            .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))
    }
}
pub(crate) fn close_session(app: &AppHandle, engine: &Engine, id: &str) -> Result<(), AppError> {
    let state = EngineState(engine);
    application::close(
        &state,
        &AppEffects {
            app: app.clone(),
            cwd: String::new(),
        },
        id,
    )?;
    if let Some(resource) = state.take_session_runtime(id)? {
        resource.close();
    }
    Ok(())
}

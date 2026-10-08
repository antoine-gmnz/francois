// editor/root.rs — code-editor FR-3: an `EditorRoot` names a root, never a raw
// path. `project` resolves to the registered project root, `session` to the
// session's cwd — which already IS its worktree when it has one.

use super::{CoreResult, EditorRoot};
use crate::ipc::{AppError, ErrorCode};
use crate::session::Engine;

/// A resolved root: the directory every path is relative to, and the root
/// picker's label (project name or session name).
pub(crate) struct RootDir {
    pub dir: String,
    pub label: String,
}

impl EditorRoot {
    /// Watch key (spec §6): `project:<id>` / `session:<id>`.
    pub(crate) fn key(&self) -> String {
        match self {
            EditorRoot::Project { project_id } => format!("project:{project_id}"),
            EditorRoot::Session { session_id } => format!("session:{session_id}"),
        }
    }
}

/// `project` is the registry lookup — `(name, root)` or `PROJECT_NOT_FOUND` —
/// injected so this stays testable without a Tauri AppHandle.
pub(crate) fn resolve_root(
    root: &EditorRoot,
    engine: &Engine,
    project: impl FnOnce(&str) -> CoreResult<(String, String)>,
) -> CoreResult<RootDir> {
    let (label, dir) = match root {
        EditorRoot::Project { project_id } => project(project_id)?,
        EditorRoot::Session { session_id } => {
            engine.ensure_available(session_id)?;
            let gone = || AppError::new(ErrorCode::SessionNotFound, "no such session");
            let dir = engine.cwd_of(session_id).ok_or_else(gone)?;
            let label = engine.name_of(session_id).ok_or_else(gone)?;
            (label, dir)
        }
    };
    Ok(RootDir { dir, label })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};

    fn no_project(_: &str) -> CoreResult<(String, String)> {
        Err(AppError::new(ErrorCode::ProjectNotFound, "no such project"))
    }

    #[test]
    fn keys_are_namespaced_by_kind() {
        let p = EditorRoot::Project {
            project_id: "a".into(),
        };
        let s = EditorRoot::Session {
            session_id: "a".into(),
        };
        assert_eq!(p.key(), "project:a");
        assert_eq!(s.key(), "session:a");
    }

    #[test]
    fn session_root_is_the_cwd_labelled_by_the_session_name() {
        let engine = test_engine_with(test_session());
        let r = EditorRoot::Session {
            session_id: "s1".into(),
        };
        let d = resolve_root(&r, &engine, no_project).unwrap();
        assert_eq!((d.dir.as_str(), d.label.as_str()), ("/x", "n"));
        let missing = EditorRoot::Session {
            session_id: "nope".into(),
        };
        let e = resolve_root(&missing, &engine, no_project).err().unwrap();
        assert_eq!(e.code, ErrorCode::SessionNotFound);
    }

    #[test]
    fn project_root_comes_from_the_registry_lookup() {
        let engine = test_engine_with(test_session());
        let r = EditorRoot::Project {
            project_id: "p1".into(),
        };
        let d = resolve_root(&r, &engine, |id| {
            assert_eq!(id, "p1");
            Ok(("orbit".into(), "/w/orbit".into()))
        })
        .unwrap();
        assert_eq!((d.dir.as_str(), d.label.as_str()), ("/w/orbit", "orbit"));
        let e = resolve_root(&r, &engine, no_project).err().unwrap();
        assert_eq!(e.code, ErrorCode::ProjectNotFound);
    }
}

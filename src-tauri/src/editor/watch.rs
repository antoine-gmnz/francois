// editor/watch.rs — code-editor FR-10: one debounced watch per open file.
//
// Each open (root, path) watches the file's PARENT directory (non-recursive),
// because agents usually replace a file by rename — a watch on the inode itself
// would go deaf after the first atomic write. Events for sibling files are
// filtered out by name. After a 150 ms quiet period the file's version is
// recomputed and compared with the last version this watch knows about
// (recorded on open and on the core's own save), which is what keeps our own
// write from echoing back as `editor.changed`.

use super::files::version_of;
use super::{EditorEvent, EditorRoot, EDITOR_WATCH_DEBOUNCE_MS};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) type Emitter = Arc<dyn Fn(EditorEvent) + Send + Sync>;

struct Watch {
    _watcher: RecommendedWatcher,
    /// Last version this watch knows the file to have; None = deleted/unknown.
    last: Arc<Mutex<Option<String>>>,
}

/// Tauri-managed state: watched paths keyed by `(root.key(), rel)` (spec §6). No persistence.
#[derive(Default)]
pub struct EditorState {
    watches: Mutex<HashMap<(String, String), Watch>>,
}

impl EditorState {
    /// Idempotent: a path that is already watched keeps its single watch and only
    /// has its known version refreshed.
    pub(crate) fn watch(
        &self,
        root: &EditorRoot,
        rel: &str,
        abs: &Path,
        version: Option<String>,
        emit: Emitter,
    ) {
        let key = (root.key(), rel.to_string());
        let mut map = self.watches.lock().unwrap();
        if let Some(w) = map.get(&key) {
            *w.last.lock().unwrap() = version;
            return;
        }
        let Some(parent) = abs.parent() else { return };
        let Some(name) = abs.file_name().map(|n| n.to_owned()) else {
            return;
        };
        let (tx, rx) = channel::<()>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if ev
                    .paths
                    .iter()
                    .any(|p| p.file_name() == Some(name.as_os_str()))
                {
                    let _ = tx.send(());
                }
            }
        });
        let Ok(mut watcher) = watcher else { return };
        if watcher.watch(parent, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        let last = Arc::new(Mutex::new(version));
        let (last2, abs2, root2, path) = (
            last.clone(),
            abs.to_path_buf(),
            root.clone(),
            rel.to_string(),
        );
        std::thread::spawn(move || run(rx, last2, abs2, root2, path, emit));
        map.insert(
            key,
            Watch {
                _watcher: watcher,
                last,
            },
        );
    }

    /// The core's own write: record the new version so it is not reported back.
    pub(crate) fn record(&self, root: &EditorRoot, rel: &str, version: &str) {
        let map = self.watches.lock().unwrap();
        if let Some(w) = map.get(&(root.key(), rel.to_string())) {
            *w.last.lock().unwrap() = Some(version.to_string());
        }
    }

    /// Stops the watch (dropping the watcher ends the debounce thread). Unwatched = ok.
    pub(crate) fn unwatch(&self, root: &EditorRoot, rel: &str) {
        self.watches
            .lock()
            .unwrap()
            .remove(&(root.key(), rel.to_string()));
    }

    /// The root went away (session ended): drop every watch under it. Returns how many.
    pub(crate) fn drop_root(&self, root: &EditorRoot) -> usize {
        let key = root.key();
        let mut map = self.watches.lock().unwrap();
        let before = map.len();
        map.retain(|(k, _), _| *k != key);
        before - map.len()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.watches.lock().unwrap().len()
    }
}

fn run(
    rx: std::sync::mpsc::Receiver<()>,
    last: Arc<Mutex<Option<String>>>,
    abs: PathBuf,
    root: EditorRoot,
    path: String,
    emit: Emitter,
) {
    let debounce = Duration::from_millis(EDITOR_WATCH_DEBOUNCE_MS);
    while rx.recv().is_ok() {
        loop {
            match rx.recv_timeout(debounce) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let current = version_of(&abs);
        let mut known = last.lock().unwrap();
        if *known == current {
            continue;
        }
        known.clone_from(&current);
        drop(known);
        emit(match current {
            Some(version) => EditorEvent::Changed {
                root: root.clone(),
                path: path.clone(),
                version,
            },
            None => EditorEvent::Deleted {
                root: root.clone(),
                path: path.clone(),
            },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use std::sync::mpsc::Receiver;

    fn s1() -> EditorRoot {
        EditorRoot::Session {
            session_id: "s1".into(),
        }
    }

    fn watch_file(
        state: &EditorState,
        dir: &TempDir,
        name: &str,
    ) -> (Receiver<EditorEvent>, PathBuf) {
        let abs = dir.path().join(name);
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let emit: Emitter = Arc::new(move |ev| {
            let _ = tx.lock().unwrap().send(ev);
        });
        state.watch(&s1(), name, &abs, version_of(&abs), emit);
        (rx, abs)
    }

    #[test]
    fn external_change_is_reported_once_debounced() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let state = EditorState::default();
        let (rx, abs) = watch_file(&state, &dir, "a.txt");
        std::fs::write(&abs, "two!").unwrap();
        std::fs::write(&abs, "three").unwrap();
        let ev = rx.recv_timeout(Duration::from_secs(10)).expect("event");
        match ev {
            EditorEvent::Changed {
                root,
                path,
                version,
            } => {
                assert_eq!(root, s1());
                assert_eq!(path, "a.txt");
                assert_eq!(Some(version), version_of(&abs));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(rx.recv_timeout(Duration::from_millis(700)).is_err());
    }

    #[test]
    fn own_save_does_not_echo_and_deletion_is_reported() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let state = EditorState::default();
        let (rx, abs) = watch_file(&state, &dir, "a.txt");
        std::fs::write(&abs, "mine").unwrap();
        state.record(&s1(), "a.txt", &version_of(&abs).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());
        std::fs::remove_file(&abs).unwrap();
        let ev = rx.recv_timeout(Duration::from_secs(10)).expect("deleted");
        assert!(matches!(ev, EditorEvent::Deleted { .. }));
    }

    #[test]
    fn watch_is_idempotent_and_dropped_per_path_and_per_root() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join("a.txt"), "1").unwrap();
        std::fs::write(dir.path().join("b.txt"), "2").unwrap();
        let state = EditorState::default();
        let _a1 = watch_file(&state, &dir, "a.txt");
        let _a2 = watch_file(&state, &dir, "a.txt");
        let _b = watch_file(&state, &dir, "b.txt");
        assert_eq!(state.len(), 2);
        state.unwatch(&s1(), "a.txt");
        state.unwatch(&s1(), "never-watched");
        assert_eq!(state.len(), 1);
        let project_s1 = EditorRoot::Project {
            project_id: "s1".into(),
        };
        assert_eq!(
            state.drop_root(&project_s1),
            0,
            "keys are namespaced by kind"
        );
        assert_eq!(state.drop_root(&s1()), 1);
        assert_eq!(state.len(), 0);
    }
}

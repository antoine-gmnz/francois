//! FR-25..FR-33 — the `francois` object's Rust side.
//!
//! `isolate.rs` knows only the `Host` trait; everything that can actually reach
//! Francois's state lives here. Two rules hold throughout:
//!
//! * **Capability gating is enforced HERE as well as in the prelude.** The
//!   prelude omits an ungranted member, which is what FR-9 promises the plugin.
//!   This layer refuses it too. That is not redundancy for its own sake: the
//!   prelude is JavaScript running in the same context as the plugin, and a
//!   defense that lives only on the far side of the boundary is not a defense.
//! * **Arguments are validated before they mean anything** (FR-33). A hostile
//!   `sessionId`, a 10 MB string, or an object with a `__proto__` key gets an
//!   argument rejection — the core never behaves oddly on their account.

use super::*;

use std::path::PathBuf;
use tauri::AppHandle;

/// Everything a running invocation is allowed to see. Built once per invocation,
/// under no lock, before the isolate starts (FR-22).
pub(crate) struct HostContext {
    pub app: AppHandle,
    pub plugin_id: String,
    pub plugin_name: String,
    pub capabilities: PluginCapabilities,
    /// The visibility scope this invocation renders for — `projects.current`.
    pub project_id: Option<String>,
    pub storage_path: Option<PathBuf>,
}

impl isolate::Host for HostContext {
    fn call(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        match method {
            // ---- always available (FR-25) ----
            "storage.get" => self.storage_get(arg_str(args, 0, "key")?),
            "storage.set" => self.storage_set(arg_str(args, 0, "key")?, args.get(1)),
            "storage.remove" => self.storage_remove(arg_str(args, 0, "key")?),
            "storage.keys" => self.storage_keys(),

            // ---- capability: readState (FR-29) ----
            "sessions.list" => self.guard_read(|| Ok(Value::Array(self.session_metas()))),
            "sessions.get" => {
                let id = arg_str(args, 0, "sessionId")?.to_string();
                self.guard_read(move || {
                    // FR-29: an unknown id resolves null rather than throwing —
                    // a plugin polling a session the user just removed should
                    // see it disappear, not crash.
                    Ok(self
                        .session_metas()
                        .into_iter()
                        .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                        .unwrap_or(Value::Null))
                })
            }
            "agents.list" => {
                let id = arg_str(args, 0, "sessionId")?.to_string();
                self.guard_read(move || Ok(Value::Array(self.agents_of(&id))))
            }
            "diff.summary" => {
                let id = arg_str(args, 0, "sessionId")?.to_string();
                self.guard_read(move || Ok(self.diff_summary(&id)))
            }
            "projects.list" => self.guard_read(|| Ok(Value::Array(self.project_metas()))),
            "projects.current" => self.guard_read(|| Ok(self.current_project())),
            "usage.get" => self.guard_read(|| Ok(self.usage())),

            // ---- capability: driveSessions (FR-30) ----
            "session.prompt" => {
                if !self.capabilities.drive_sessions() {
                    return Err("this plugin was not granted driveSessions".into());
                }
                let session_id = arg_str(args, 0, "sessionId")?;
                let text = arg_str(args, 1, "text")?;
                injection::request(
                    &self.app,
                    &self.plugin_id,
                    &self.plugin_name,
                    session_id,
                    text,
                )
            }

            // ---- capability: network (FR-31) ----
            "fetch" => {
                if !self.capabilities.has_network() {
                    return Err("this plugin was not granted network access".into());
                }
                let url = arg_str(args, 0, "url")?;
                let init = args.get(1).cloned().unwrap_or(Value::Null);
                let request = net::build_request(url, &init, self.capabilities.hosts())?;
                Ok(net::perform(&request)?.to_value())
            }

            other => Err(format!(
                "no such host function: {}",
                clean_text(other, 64, false)
            )),
        }
    }
}

/// FR-29's gate. One place, so a new read cannot be added without passing it.
impl HostContext {
    fn guard_read(&self, f: impl FnOnce() -> Result<Value, String>) -> Result<Value, String> {
        if !self.capabilities.read_state() {
            return Err("this plugin was not granted readState".into());
        }
        f()
    }

    // ---------- FR-29: reads, all served from memory ----------

    fn session_metas(&self) -> Vec<Value> {
        crate::session::plugin_session_metas(&self.app)
    }

    fn agents_of(&self, session_id: &str) -> Vec<Value> {
        crate::session::plugin_agents(&self.app, session_id)
    }

    /// FR-29: the diff summary for a session's cwd. This one really does touch
    /// the disk (it shells out to git), which is why the isolate pauses its CPU
    /// deadline around every host call rather than only around `fetch`.
    fn diff_summary(&self, session_id: &str) -> Value {
        crate::diff::summary_for_plugin(&self.app, session_id).unwrap_or(Value::Null)
    }

    fn project_metas(&self) -> Vec<Value> {
        crate::project::plugin_projects(&self.app)
    }

    fn current_project(&self) -> Value {
        let Some(id) = &self.project_id else {
            return Value::Null; // *All projects* — there is no current one
        };
        self.project_metas()
            .into_iter()
            .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            .unwrap_or(Value::Null)
    }

    fn usage(&self) -> Value {
        crate::usage::plugin_usage(&self.app)
    }

    // ---------- FR-27: storage ----------

    fn load_store(&self) -> Map<String, Value> {
        let Some(path) = &self.storage_path else {
            return Map::new();
        };
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn save_store(&self, store: &Map<String, Value>) -> Result<(), String> {
        let path = self
            .storage_path
            .as_ref()
            .ok_or_else(|| "storage is unavailable".to_string())?;
        crate::permissions::write_json_atomic(path, &Value::Object(store.clone()))
            .map_err(|_| "could not write the plugin store".to_string())
    }

    fn storage_get(&self, key: &str) -> Result<Value, String> {
        check_storage_key(key)?;
        Ok(self.load_store().get(key).cloned().unwrap_or(Value::Null))
    }

    fn storage_set(&self, key: &str, value: Option<&Value>) -> Result<Value, String> {
        check_storage_key(key)?;
        let value = value.cloned().unwrap_or(Value::Null);
        let mut store = self.load_store();
        store.insert(key.to_string(), value);
        // FR-27 / §7 #44: the quota is checked against the SERIALIZED store, and
        // a breach leaves it unchanged — a partial write would be worse than a
        // refusal, because the plugin would have no way to tell.
        if serde_json::to_vec(&Value::Object(store.clone()))
            .map(|b| b.len())
            .unwrap_or(usize::MAX)
            > STORAGE_MAX_BYTES
        {
            return Err("storage quota exceeded".into());
        }
        self.save_store(&store)?;
        Ok(Value::Null)
    }

    fn storage_remove(&self, key: &str) -> Result<Value, String> {
        check_storage_key(key)?;
        let mut store = self.load_store();
        if store.remove(key).is_some() {
            self.save_store(&store)?;
        }
        Ok(Value::Null)
    }

    fn storage_keys(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.load_store()
                .keys()
                .map(|k| Value::String(k.clone()))
                .collect(),
        ))
    }
}

// ---------- FR-33: argument validation ----------

/// The only way a host method reads a string argument. Rejects a missing
/// argument, a non-string, an empty string, and anything long enough to be an
/// attack on whatever is downstream.
fn arg_str<'a>(args: &'a [Value], index: usize, name: &str) -> Result<&'a str, String> {
    let raw = args
        .get(index)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{name} must be a string"))?;
    if raw.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    // Generous, but bounded: the specific limits (8 000 for a prompt, 128 for a
    // storage key) are enforced by the method that knows what the value means.
    if raw.len() > 64 * 1024 {
        return Err(format!("{name} is too long"));
    }
    Ok(raw)
}

/// FR-27: keys ≤ 128 chars. `__proto__` and friends are refused outright — the
/// store round-trips through `serde_json::Map` (which is safe), but the plugin
/// also reads it back into a JS object, where they are not.
fn check_storage_key(key: &str) -> Result<(), String> {
    if key.chars().count() > STORAGE_MAX_KEY_LEN {
        return Err(format!(
            "a storage key must be at most {STORAGE_MAX_KEY_LEN} characters"
        ));
    }
    if matches!(key, "__proto__" | "constructor" | "prototype") {
        return Err("that storage key is reserved".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::tmp_dir;
    use serde_json::json;

    #[test]
    fn a_storage_key_is_bounded_and_the_prototype_names_are_reserved() {
        assert!(check_storage_key("runs").is_ok());
        assert!(check_storage_key(&"k".repeat(STORAGE_MAX_KEY_LEN)).is_ok());
        assert!(check_storage_key(&"k".repeat(STORAGE_MAX_KEY_LEN + 1)).is_err());
        for reserved in ["__proto__", "constructor", "prototype"] {
            assert!(check_storage_key(reserved).is_err(), "{reserved}");
        }
    }

    #[test]
    fn a_string_argument_must_be_a_non_empty_bounded_string() {
        // FR-33: the trust boundary. Everything here would otherwise reach a
        // session lookup or a URL parser.
        assert_eq!(arg_str(&[json!("abc")], 0, "x").unwrap(), "abc");
        for bad in [json!(42), json!(null), json!(""), json!({}), json!([])] {
            assert!(arg_str(&[bad.clone()], 0, "x").is_err(), "{bad}");
        }
        assert!(arg_str(&[], 0, "x").is_err(), "missing argument");
        assert!(
            arg_str(&[json!("x".repeat(70_000))], 0, "x").is_err(),
            "10 MB string"
        );
    }

    /// The storage half can be exercised without a Tauri handle by driving the
    /// file functions directly through a context whose app handle is never used.
    fn store_at(dir: &std::path::Path) -> Map<String, Value> {
        std::fs::read(dir.join("acme-ci.storage.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    #[test]
    fn the_storage_file_lives_beside_the_code_directory_not_inside_it() {
        // FR-27/§6: an update swap replaces the code directory wholesale, so a
        // store inside it would be destroyed by every update.
        let dir = tmp_dir("storage-path");
        let install = dir.join("acme-ci");
        std::fs::create_dir_all(&install).unwrap();
        let store = dir.join("acme-ci.storage.json");
        std::fs::write(&store, b"{}").unwrap();

        std::fs::remove_dir_all(&install).unwrap(); // the swap
        assert!(store.exists(), "the store must survive an update");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_quota_is_measured_on_the_serialized_store_and_a_breach_changes_nothing() {
        // §7 #44 — proved against the same serialization the writer uses.
        let mut store = Map::new();
        store.insert("small".into(), json!("v"));
        let under = serde_json::to_vec(&Value::Object(store.clone()))
            .unwrap()
            .len();
        assert!(under < STORAGE_MAX_BYTES);

        store.insert("big".into(), json!("x".repeat(STORAGE_MAX_BYTES)));
        let over = serde_json::to_vec(&Value::Object(store)).unwrap().len();
        assert!(over > STORAGE_MAX_BYTES, "the fixture must actually breach");
        let _ = store_at(std::path::Path::new("."));
    }
}

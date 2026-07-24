// permissions.rs — permission-guardrails (specs/permission-guardrails.md).
//
// Everything file- and pattern-shaped lives here; the control-channel wiring
// (parking an ask, writing the control_response) lives in session.rs, which
// calls into this module. Nothing here touches the session engine's state.
//
// The contract this module implements is Claude Code's OWN settings format:
// rules are written into `permissions.allow` / `permissions.deny` of a real
// settings.json, which means Claude enforces them UPSTREAM of the control
// channel — a ruled call never reaches Francois again (spec §1). Three
// processes write those files (the claude CLI, the user's editor, Francois), so
// every write here is a surgical read → touch one array → write-back that
// preserves every other key (FR-14). An unparseable file is NEVER overwritten.
//
// Rule ids are DERIVED (`tier|effect|pattern`, FR-16) — nothing about a rule is
// stored outside the settings file, except the "disabled" parking lot in the
// Francois-owned sidecar (FR-15), which Claude never reads.

use crate::ipc::{err, ok, IpcResult};
use crate::session::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::State;

// ---------- contract types (contract/permission-guardrails.ts, mirrored) ----------

/// Mirrors PermissionAsk in contract/common.ts.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PermissionAsk {
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub summary: String,
    #[serde(rename = "inputJson")]
    pub input_json: String,
    pub cwd: String,
    pub pattern: String,
    #[serde(rename = "patternLabel")]
    pub pattern_label: String,
}

/// Mirrors PermissionRule in contract/common.ts. Every field name is a single
/// lowercase word, so serde needs no renames.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PermissionRule {
    pub id: String,
    pub pattern: String,
    pub effect: String,
    pub tier: String,
    pub enabled: bool,
    pub label: String,
}

/// FR-17 listing order: deny first (the rules that stop things), then ask, then allow.
const EFFECT_ORDER: [&str; 3] = ["deny", "ask", "allow"];

/// The sidecar file that parks toggled-off rules (FR-15). Francois is its ONLY
/// writer, so it carries none of the three-writer risk settings.json does.
const SIDECAR_NAME: &str = "francois-permissions.json";

// ---------- FR-4: input summary ----------

/// FR-4: the one-line human rendering of a tool call — the line the card leads
/// with. `''` when the tool exposes no obvious "what" key (the card still shows
/// the whole input JSON, so nothing is hidden).
pub fn summarize_input(tool: &str, input: &Value) -> String {
    let s = |key: &str| -> Option<String> {
        input
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let picked = match tool {
        "Bash" => s("command"),
        "Read" | "Edit" | "Write" | "MultiEdit" => s("file_path"),
        "NotebookEdit" => s("notebook_path").or_else(|| s("file_path")),
        "Glob" | "Grep" | "LS" => s("path"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        _ => None,
    };
    picked.unwrap_or_default()
}

/// FR-4: the whole tool input, pretty-printed, truncated to 4000 chars. A
/// non-object input still renders (the CLI is free to send anything).
pub fn input_json(input: &Value) -> String {
    let full = serde_json::to_string_pretty(input).unwrap_or_else(|_| "{}".into());
    if full.chars().count() <= 4000 {
        return full;
    }
    let head: String = full.chars().take(4000).collect();
    format!("{head}\n…")
}

// ---------- FR-5: pattern generation ----------

/// Programs whose FIRST ARGUMENT is a subcommand, so a useful rule prefix is two
/// tokens (`git commit`, `npm test`) rather than the bare program (`git` — which
/// would trust every git operation including `push --force`).
const SUBCOMMAND_PROGRAMS: [&str; 30] = [
    "git",
    "gh",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "cargo",
    "docker",
    "kubectl",
    "go",
    "make",
    "uv",
    "pip",
    "pip3",
    "poetry",
    "dotnet",
    "bundle",
    "rails",
    "terraform",
    "aws",
    "gcloud",
    "brew",
    "apt",
    "apt-get",
    "systemctl",
    "python",
    "python3",
    "node",
    "deno",
    "bun",
];

/// Shell metacharacters that make a prefix rule unsafe: with any of these present
/// `Bash(cd x:*)` would also authorize whatever rides after the operator, so the
/// generated rule pins the EXACT command instead (FR-5, §7 #11).
///
/// SINGLE characters, deliberately: `&&`/`||`/`$(` are covered by `&`/`|`/`$`,
/// and the review found the pair-only list let `npm test & rm -rf ~` through the
/// PREFIX branch — a bare `&` separates commands exactly like `&&` does. Being
/// over-inclusive here only ever makes a generated rule NARROWER (an exact-command
/// pin instead of a prefix), so anything that could plausibly chain, substitute,
/// redirect or comment gets listed.
const SHELL_OPERATORS: [char; 15] = [
    '&', '|', ';', '`', '$', '>', '<', '(', ')', '{', '}', '#', '!', '\n', '\r',
];

fn has_shell_operator(cmd: &str) -> bool {
    cmd.contains(SHELL_OPERATORS)
}

/// FR-5: the command prefix a `Bash(<prefix>:*)` rule is built from — the first
/// token, extended with the second when the first is a subcommand-style program
/// and the second is not a flag.
fn bash_prefix(cmd: &str) -> String {
    let mut it = cmd.split_whitespace();
    let Some(first) = it.next() else {
        return String::new();
    };
    let second = it.next();
    match second {
        Some(sec)
            if SUBCOMMAND_PROGRAMS.contains(&first) && !sec.starts_with('-') && !sec.is_empty() =>
        {
            format!("{first} {sec}")
        }
        _ => first.to_string(),
    }
}

fn slashed(p: &str) -> String {
    p.replace('\\', "/")
}

/// A tool path expressed relative to the session cwd when it lives inside it,
/// otherwise verbatim (with `/` separators). Case-insensitive prefix match — the
/// two platforms Francois runs on disagree about path case, and a rule that
/// silently fails to match is worse than one that is slightly too generous about
/// spelling.
fn path_relative_to_cwd(path: &str, cwd: &str) -> String {
    let p = slashed(path);
    let c = slashed(cwd);
    let c = c.trim_end_matches('/');
    if c.is_empty() {
        return p;
    }
    // Compare and slice on the SAME string. The earlier version matched on
    // `to_lowercase()` copies but sliced `p` at the original byte offset —
    // `char::to_lowercase` is not length-preserving (`İ` U+0130 is 2 bytes and
    // lowercases to 3), so a case-differing path could slice off a UTF-8
    // boundary and PANIC on the turn's reader thread, poisoning every pending
    // map behind it. ASCII-only case folding keeps byte offsets exact.
    let head = match p.get(..c.len()) {
        Some(h) if h.eq_ignore_ascii_case(c) => h,
        _ => return p,
    };
    debug_assert_eq!(head.len(), c.len());
    match p.get(c.len()..) {
        Some(rest) if rest.starts_with('/') => p[c.len() + 1..].to_string(),
        _ => p,
    }
}

/// The host of a URL: everything between `://` and the next path/query/fragment
/// delimiter, minus any userinfo and port. `None` when the string has no
/// recognizable host.
///
/// `\` is a delimiter too: WHATWG URL parsing treats it as `/` in a special
/// scheme, so `https://evil.com\@good.com/x` FETCHES evil.com. Splitting on `/`
/// alone made this function report `good.com` — the card would have read "fetch
/// from good.com" and offered that domain as the rule for a call going somewhere
/// else. Anything still containing a delimiter-ish character after the split is
/// rejected outright rather than guessed at.
fn url_host(url: &str) -> Option<String> {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '\\' | '@' | '[' | ']' | '/'))
    {
        return None;
    }
    Some(host.to_lowercase())
}

/// The exact-command form `Bash(<cmd>)` — a rule that pins ONE command instead of
/// a prefix, used whenever a shell operator makes a prefix unsafe.
///
/// Two inputs cannot be expressed in that form and must NOT be smuggled into it:
///   * a command ending in `:*` — Claude re-reads `Bash(echo x:*)` as a PREFIX
///     rule, so the "exact pin" branch would silently hand out a wildcard;
///   * a command containing `)` — the pattern's closing paren becomes ambiguous.
/// Both degrade to the bare tool name, whose label reads "any Bash call" (§7 #12).
/// That is deliberately a rule the user is likely to REFUSE: failing toward
/// something obviously too broad is safe, failing toward something that LOOKS
/// narrow while granting more is not.
fn exact_bash_pattern(cmd: &str) -> String {
    if cmd.ends_with(":*") || cmd.contains(')') {
        return "Bash".to_string();
    }
    format!("Bash({cmd})")
}

/// Tools whose input names a filesystem path, and the key that holds it.
fn path_key(tool: &str) -> Option<&'static [&'static str]> {
    match tool {
        "Read" | "Edit" | "Write" | "MultiEdit" => Some(&["file_path"]),
        "NotebookEdit" => Some(&["notebook_path", "file_path"]),
        "Glob" | "Grep" | "LS" => Some(&["path"]),
        _ => None,
    }
}

/// FR-5: the Claude permission pattern Francois would write for this call.
/// Pure; the whole §9 pattern table is pinned against it.
pub fn generate_pattern(tool: &str, input: &Value, cwd: &str) -> String {
    if tool.starts_with("mcp__") {
        // An MCP tool name IS its own pattern (`mcp__server__tool` scopes one
        // tool, `mcp__server` the whole server).
        return tool.to_string();
    }
    if tool == "Bash" {
        let cmd = input
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();
        if cmd.is_empty() {
            return "Bash".to_string();
        }
        if has_shell_operator(cmd) {
            return exact_bash_pattern(cmd);
        }
        let prefix = bash_prefix(cmd);
        if prefix.is_empty() {
            return "Bash".to_string();
        }
        return format!("Bash({prefix}:*)");
    }
    if tool == "WebFetch" {
        if let Some(host) = input
            .get("url")
            .and_then(|u| u.as_str())
            .and_then(url_host)
        {
            return format!("WebFetch(domain:{host})");
        }
        return "WebFetch".to_string();
    }
    if let Some(keys) = path_key(tool) {
        for k in keys {
            if let Some(p) = input.get(*k).and_then(|v| v.as_str()).filter(|p| !p.is_empty()) {
                return format!("{tool}({})", path_relative_to_cwd(p, cwd));
            }
        }
    }
    tool.to_string()
}

/// The verb a path-shaped tool reads as in a rule label.
fn tool_verb(tool: &str) -> String {
    match tool {
        "Read" => "read".into(),
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit".into(),
        "Write" => "write".into(),
        "Glob" | "LS" => "list".into(),
        "Grep" => "search".into(),
        other => other.to_lowercase(),
    }
}

/// FR-5/FR-17: the human reading of a RAW pattern. Deliberately derived from the
/// pattern rather than from the call, so a rule generated by Francois and the
/// same rule read back off disk (or hand-written by the user) always read the
/// same way in the card and in the editor.
pub fn label_for_pattern(pattern: &str) -> String {
    if let Some(rest) = pattern.strip_prefix("mcp__") {
        return match rest.split_once("__") {
            Some((server, tool)) if !tool.is_empty() => {
                format!("{tool} on the {server} MCP server")
            }
            _ => format!("any tool on the {rest} MCP server"),
        };
    }
    let Some((tool, arg)) = split_pattern(pattern) else {
        return format!("any {pattern} call");
    };
    if tool == "Bash" {
        return match arg.strip_suffix(":*") {
            Some(prefix) => format!("{prefix} (any arguments)"),
            // FR-5's wording. The command itself is always rendered beside the
            // label (the card's summary + pattern, the editor's pattern column),
            // so repeating it here would only duplicate.
            None => "run exactly this command".to_string(),
        };
    }
    if tool == "WebFetch" {
        if let Some(domain) = arg.strip_prefix("domain:") {
            return format!("fetch from {domain}");
        }
    }
    format!("{} {}", tool_verb(tool), arg)
}

/// `Tool(arg)` → `("Tool", "arg")`. `None` for a bare tool name. The argument may
/// itself contain parentheses (a Bash command does), so the match is on the FIRST
/// `(` and the LAST `)`.
fn split_pattern(pattern: &str) -> Option<(&str, &str)> {
    let open = pattern.find('(')?;
    let close = pattern.rfind(')')?;
    if close <= open {
        return None;
    }
    Some((&pattern[..open], &pattern[open + 1..close]))
}

/// FR-2..FR-5: everything the approval card needs, derived purely from the
/// control request plus the session's cwd.
pub fn build_ask(tool: &str, input: &Value, cwd: &str) -> PermissionAsk {
    let pattern = generate_pattern(tool, input, cwd);
    PermissionAsk {
        tool_name: tool.to_string(),
        summary: summarize_input(tool, input),
        input_json: input_json(input),
        cwd: cwd.to_string(),
        pattern_label: label_for_pattern(&pattern),
        pattern,
    }
}

// ---------- FR-16: rule identity ----------

pub fn rule_id(tier: &str, effect: &str, pattern: &str) -> String {
    format!("{tier}|{effect}|{pattern}")
}

/// Split a rule id back into its parts. `splitn(3)` because a pattern may itself
/// contain `|` (`Bash(a || b)`) while a tier and an effect never can.
fn parse_rule_id(id: &str) -> Option<(String, String, String)> {
    let mut it = id.splitn(3, '|');
    let tier = it.next()?;
    let effect = it.next()?;
    let pattern = it.next()?;
    if pattern.is_empty() || !EFFECT_ORDER.contains(&effect) {
        return None;
    }
    Some((tier.into(), effect.into(), pattern.into()))
}

// ---------- FR-13: tier paths ----------

/// FR-13: `<cwd>/.claude/settings.local.json` — the DEFAULT tier, so a trust
/// decision made in one repo never leaks into another (§2 goals).
pub fn local_settings_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".claude").join("settings.local.json")
}

/// FR-13: `<claude home>/.claude/settings.json`. For a `wsl` session that home is
/// the DISTRO's home, reached through the wsl-filesystem UNC root — a Windows
/// `~/.claude` is a file the session's claude never reads. `None` when the home
/// cannot be resolved (the global tier is then unavailable, §7 #4).
pub fn global_settings_path(cwd: &str, runtime: &str) -> Option<PathBuf> {
    // `dirs::home_dir()` and NOT a hand-rolled USERPROFILE/HOME probe: every other
    // home lookup in the crate (session.rs, usage.rs) uses it, and on Windows a
    // shell-set HOME would otherwise point the global tier at a `.claude` the rest
    // of the app never reads.
    let home = if runtime == "wsl" {
        crate::wsl::wsl_home_unc(cwd).map(PathBuf::from)
    } else {
        dirs::home_dir()
    }?;
    Some(home.join(".claude").join("settings.json"))
}

/// The Francois-owned disabled-rules sidecar next to a settings file (FR-15).
fn sidecar_path(settings: &Path) -> PathBuf {
    match settings.parent() {
        Some(dir) => dir.join(SIDECAR_NAME),
        None => PathBuf::from(SIDECAR_NAME),
    }
}

// ---------- FR-14: surgical read / merge / write ----------

/// Read a JSON object file. Missing or empty → `{}` (a read NEVER creates
/// anything, §7 #3). Unparseable or non-object → `Err` — the caller must refuse
/// to write rather than clobber a file it does not understand (§7 #2).
pub fn read_json_object(path: &Path) -> Result<Value, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Object(Map::new())),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    if content.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    match serde_json::from_str::<Value>(&content) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{} is not valid JSON: {e}", path.display())),
    }
}

/// Monotonic counter making each temp filename unique within the process. The
/// name used to be a constant per target, so two concurrent writers to the same
/// file (a decide racing the editor modal, or two sessions sharing a cwd) could
/// interleave and clobber each other's temp file.
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write a JSON document back, 2-space pretty, via temp file + atomic rename so a
/// crash mid-write can never leave a torn settings.json.
///
/// The temp file INHERITS the target's permissions when the target exists, and is
/// created 0600 otherwise (Unix). This matters because the whole document is
/// rewritten: `~/.claude/settings.json` routinely carries secrets under `env`
/// (`ANTHROPIC_API_KEY` and friends), and a 0600 file silently becoming
/// umask-default 0644 on Francois's first write would leak them to every local
/// user.
pub fn write_json_atomic(path: &Path, doc: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let mut bytes =
        serde_json::to_vec_pretty(doc).map_err(|e| format!("could not serialize rules: {e}"))?;
    bytes.push(b'\n');
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    write_private(&tmp, &bytes, path)
        .map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })
}

/// Create `tmp` with `bytes`, carrying over `target`'s permissions if it exists.
#[cfg(unix)]
fn write_private(tmp: &Path, bytes: &[u8], target: &Path) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let mode = std::fs::metadata(target)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o600); // a NEW settings file is private by default
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(tmp)?;
    f.write_all(bytes)?;
    // `mode` only applies at creation — a pre-existing temp file keeps its own.
    std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(mode))?;
    f.sync_all()
}

/// Windows has no umask and no group/other bits to leak through; the ACL is
/// inherited from the directory, which is the same directory the target lives in.
#[cfg(not(unix))]
fn write_private(tmp: &Path, bytes: &[u8], target: &Path) -> std::io::Result<()> {
    std::fs::write(tmp, bytes)?;
    if let Ok(meta) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(tmp, meta.permissions()); // carries read-only
    }
    Ok(())
}

/// The `permissions.<effect>` array of a settings document, created on demand.
/// `None` for a non-object document — callers pass a `read_json_object` result so
/// that cannot happen today, but `merge_pattern`/`remove_pattern` are `pub` and a
/// panic here would land on the turn's reader thread.
fn effect_array<'a>(doc: &'a mut Value, effect: &str) -> Option<&'a mut Vec<Value>> {
    let root = doc.as_object_mut()?;
    let perms = root
        .entry("permissions")
        .or_insert_with(|| Value::Object(Map::new()));
    if !perms.is_object() {
        *perms = Value::Object(Map::new());
    }
    let po = perms.as_object_mut()?;
    let arr = po
        .entry(effect)
        .or_insert_with(|| Value::Array(Vec::new()));
    if !arr.is_array() {
        *arr = Value::Array(Vec::new());
    }
    arr.as_array_mut()
}

/// FR-14: append the pattern to `permissions.<effect>` iff absent. Every other
/// key of the document — and every other entry of the array — is untouched.
/// Returns true when the document changed.
pub fn merge_pattern(doc: &mut Value, effect: &str, pattern: &str) -> bool {
    let Some(arr) = effect_array(doc, effect) else {
        return false; // non-object document — nothing to merge into
    };
    if arr.iter().any(|v| v.as_str() == Some(pattern)) {
        return false; // §7 #1: already trusted — idempotent
    }
    arr.push(Value::String(pattern.into()));
    true
}

/// FR-14: drop the pattern from `permissions.<effect>`. An array that empties is
/// left as `[]`, not deleted, so the file's shape stays stable across edits.
/// Returns true when the document changed.
pub fn remove_pattern(doc: &mut Value, effect: &str, pattern: &str) -> bool {
    let Some(arr) = doc
        .get_mut("permissions")
        .and_then(|p| p.get_mut(effect))
        .and_then(|a| a.as_array_mut())
    else {
        return false;
    };
    let before = arr.len();
    arr.retain(|v| v.as_str() != Some(pattern));
    before != arr.len()
}

/// Read the patterns of one effect off a settings document, skipping non-strings
/// (§7 #15 — they are preserved on write, just not listed).
fn patterns_of(doc: &Value, effect: &str) -> Vec<String> {
    doc.get("permissions")
        .and_then(|p| p.get(effect))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------- FR-15: the disabled sidecar ----------

/// `(effect, pattern)` pairs parked in the sidecar. A missing or unparseable
/// sidecar reads as empty — it is a Francois convenience, never a source of truth
/// worth failing an operation over.
fn read_disabled(settings: &Path) -> Vec<(String, String)> {
    let Ok(doc) = read_json_object(&sidecar_path(settings)) else {
        return Vec::new();
    };
    doc.get("disabled")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let effect = e.get("effect")?.as_str()?;
                    let pattern = e.get("pattern")?.as_str()?;
                    EFFECT_ORDER
                        .contains(&effect)
                        .then(|| (effect.to_string(), pattern.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Rewrite the sidecar's `disabled` array, preserving any other key it carries.
fn write_disabled(settings: &Path, entries: &[(String, String)]) -> Result<(), String> {
    let path = sidecar_path(settings);
    let mut doc = read_json_object(&path).unwrap_or_else(|_| Value::Object(Map::new()));
    let arr: Vec<Value> = entries
        .iter()
        .map(|(effect, pattern)| serde_json::json!({ "effect": effect, "pattern": pattern }))
        .collect();
    let Some(obj) = doc.as_object_mut() else {
        return Err(format!("{} is not a JSON object", path.display()));
    };
    obj.insert("disabled".into(), Value::Array(arr));
    write_json_atomic(&path, &doc)
}

fn set_disabled(settings: &Path, effect: &str, pattern: &str, on: bool) -> Result<(), String> {
    let mut entries = read_disabled(settings);
    let present = entries
        .iter()
        .any(|(e, p)| e == effect && p == pattern);
    if on == present {
        return Ok(());
    }
    if on {
        entries.push((effect.to_string(), pattern.to_string()));
    } else {
        entries.retain(|(e, p)| !(e == effect && p == pattern));
    }
    write_disabled(settings, &entries)
}

// ---------- FR-17: listing ----------

fn rules_of_tier(tier: &str, settings: &Path) -> Vec<PermissionRule> {
    // A tier whose settings file is unreadable/unparseable contributes NOTHING
    // rather than failing the whole listing — the editor must still open so the
    // user can see (and fix) the other tier. Writes are where we hard-fail.
    let doc = read_json_object(settings).unwrap_or_else(|_| Value::Object(Map::new()));
    let disabled = read_disabled(settings);
    let mut out = Vec::new();
    for effect in EFFECT_ORDER {
        let live = patterns_of(&doc, effect);
        for pattern in &live {
            out.push(make_rule(tier, effect, pattern, true));
        }
        // A pattern that is live in settings.json AND parked in the sidecar must
        // list ONCE, as enabled. That state is reachable through the documented
        // three-writer scenario (§3 flow 7: the user disables a rule, then the
        // CLI or a hand edit re-adds it) and rule ids are derived from
        // tier|effect|pattern (FR-16), so listing it twice would produce two rows
        // with the SAME id — and `locate()` takes the first, so a toggle or a
        // delete could act on the wrong row. Settings.json wins: it is what Claude
        // actually enforces.
        for (_, pattern) in disabled
            .iter()
            .filter(|(e, p)| e == effect && !live.contains(p))
        {
            out.push(make_rule(tier, effect, pattern, false));
        }
    }
    out
}

fn make_rule(tier: &str, effect: &str, pattern: &str, enabled: bool) -> PermissionRule {
    PermissionRule {
        id: rule_id(tier, effect, pattern),
        pattern: pattern.to_string(),
        effect: effect.to_string(),
        tier: tier.to_string(),
        enabled,
        label: label_for_pattern(pattern),
    }
}

/// FR-17: both tiers, ordered deny → ask → allow, local before global, file order
/// within a tier (enabled entries first, then the sidecar's disabled ones).
pub fn list_rules(local: &Path, global: Option<&Path>) -> Vec<PermissionRule> {
    let l = rules_of_tier("local", local);
    let g = global.map(|p| rules_of_tier("global", p)).unwrap_or_default();
    let mut out = Vec::new();
    for effect in EFFECT_ORDER {
        out.extend(l.iter().filter(|r| r.effect == effect).cloned());
        out.extend(g.iter().filter(|r| r.effect == effect).cloned());
    }
    out
}

// ---------- FR-7/FR-14: the write a decision performs ----------

/// Write one rule into a tier's settings file, surgically. Returns the resulting
/// `PermissionRule` (already-present is a success — §7 #1). Any failure leaves
/// the file untouched, which is what lets `permissions_decide` fail before it
/// claims anything (FR-7).
pub fn write_rule(settings: &Path, tier: &str, effect: &str, pattern: &str) -> Result<PermissionRule, String> {
    let mut doc = read_json_object(settings)?;
    if merge_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    // A rule that was parked as disabled and is now being re-created must not
    // stay parked, or it would read as disabled in the editor while being live
    // in settings.json. The error PROPAGATES: swallowing it left the pattern in
    // both files at once — the duplicate-id state rules_of_tier now guards
    // against — while reporting success to the card and the editor.
    set_disabled(settings, effect, pattern, false)?;
    Ok(make_rule(tier, effect, pattern, true))
}

/// Park a pattern in the sidecar (FR-15) after taking it out of settings.json.
/// Ordering is deliberate and the REVERSE of the obvious one: the sidecar write
/// happens FIRST, so a failure between the two steps leaves the rule visible in
/// settings.json rather than deleted from both files. `permissions_set_tier`
/// reasons the same way ("present in both, visible and fixable" beats "vanished").
fn park_rule(settings: &Path, effect: &str, pattern: &str) -> Result<(), String> {
    set_disabled(settings, effect, pattern, true)?;
    let mut doc = read_json_object(settings)?;
    if remove_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    Ok(())
}

/// FR-18: move one rule between tiers, preserving whether it is enabled. Add to
/// the destination FIRST, then drop from the source — a failure half-way leaves
/// the rule present in BOTH tiers (visible, fixable) rather than gone from both.
/// Lifted out of the command so it is testable without a `State<Engine>`.
pub fn move_rule(
    from: &Path,
    to: &Path,
    to_tier: &str,
    effect: &str,
    pattern: &str,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        write_rule(to, to_tier, effect, pattern)?;
    } else {
        set_disabled(to, effect, pattern, true)?;
    }
    drop_rule(from, effect, pattern)
}

fn drop_rule(settings: &Path, effect: &str, pattern: &str) -> Result<(), String> {
    let mut doc = read_json_object(settings)?;
    if remove_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    set_disabled(settings, effect, pattern, false)
}

// ---------- Tauri commands (§5.1) ----------

/// Both tier paths for a session. `SESSION_NOT_FOUND` when the session is gone;
/// the global path is `None` when it cannot be resolved (§7 #4) — listing then
/// shows local only, and a global write reports SETTINGS_WRITE_FAILED.
fn tiers_for(engine: &Engine, session_id: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    let cwd = engine.cwd_of(session_id)?;
    let runtime = engine.runtime_of(session_id).unwrap_or_else(|| "native".into());
    Some((
        local_settings_path(&cwd),
        global_settings_path(&cwd, &runtime),
    ))
}

const NO_GLOBAL: &str = "could not locate the global Claude settings directory";

/// The only two tier names the contract's `PermissionTier` union allows.
pub fn is_valid_tier(tier: &str) -> bool {
    tier == "local" || tier == "global"
}

/// FR-6: parse a `PermissionDecision` into `(allow, remember)`. `None` ⇒
/// `INVALID_INPUT`. Split out of `permissions_decide` (which needs a
/// `State<Engine>` and an `AppHandle`, so it cannot be unit-tested) purely so the
/// decision matrix is pinned by a test.
pub fn decide_outcome(decision: &str) -> Option<(bool, bool)> {
    match decision {
        "allowOnce" => Some((true, false)),
        "denyOnce" => Some((false, false)),
        "allowAlways" => Some((true, true)),
        "denyAlways" => Some((false, true)),
        _ => None,
    }
}

/// Resolve a tier name to its settings path for a WRITE.
pub fn tier_path(
    engine: &Engine,
    session_id: &str,
    tier: &str,
) -> Result<PathBuf, (&'static str, String)> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(("SESSION_NOT_FOUND", "no such session".into()));
    };
    if tier == "global" {
        return global.ok_or(("SETTINGS_WRITE_FAILED", NO_GLOBAL.into()));
    }
    Ok(local)
}

/// francois:permissions:list (FR-17).
#[tauri::command(async)]
pub fn permissions_list(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    match tiers_for(&engine, &session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some((local, global)) => ok(list_rules(&local, global.as_deref())),
    }
}

/// Look a rule up in the FRESH list (FR-18) — an id the user is acting on may
/// have been deleted externally since the editor rendered it (§7 #13).
fn locate(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
) -> Result<(PermissionRule, PathBuf, PathBuf, Option<PathBuf>), (&'static str, String)> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(("SESSION_NOT_FOUND", "no such session".into()));
    };
    let Some((tier, _, _)) = parse_rule_id(rule_id) else {
        return Err(("RULE_NOT_FOUND", "that rule no longer exists".into()));
    };
    let rule = list_rules(&local, global.as_deref())
        .into_iter()
        .find(|r| r.id == rule_id)
        .ok_or(("RULE_NOT_FOUND", "that rule no longer exists".into()))?;
    let settings = if tier == "global" {
        global
            .clone()
            .ok_or(("SETTINGS_WRITE_FAILED", NO_GLOBAL.into()))?
    } else {
        local.clone()
    };
    Ok((rule, settings, local, global))
}

/// francois:permissions:setEnabled (FR-15/FR-18): move the pattern between
/// `permissions.<effect>` and the sidecar's parking lot.
#[tauri::command(async)]
pub fn permissions_set_enabled(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
    enabled: bool,
) -> IpcResult<Vec<PermissionRule>> {
    let (rule, settings, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if rule.enabled != enabled {
        let outcome = if enabled {
            write_rule(&settings, &rule.tier, &rule.effect, &rule.pattern).map(|_| ())
        } else {
            park_rule(&settings, &rule.effect, &rule.pattern)
        };
        if let Err(msg) = outcome {
            return err("SETTINGS_WRITE_FAILED", msg);
        }
    }
    ok(list_rules(&local, global.as_deref()))
}

/// francois:permissions:remove (FR-18): clear the pattern from BOTH the settings
/// file and the sidecar, so a delete is a real delete.
#[tauri::command(async)]
pub fn permissions_remove(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    let (rule, settings, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if let Err(msg) = drop_rule(&settings, &rule.effect, &rule.pattern) {
        return err("SETTINGS_WRITE_FAILED", msg);
    }
    ok(list_rules(&local, global.as_deref()))
}

/// francois:permissions:setTier (FR-18): move a rule between tiers, preserving
/// whether it is enabled. Same-tier is a no-op that still returns the list.
#[tauri::command(async)]
pub fn permissions_set_tier(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
    tier: String,
) -> IpcResult<Vec<PermissionRule>> {
    // Validate BEFORE locate(): §5.1 lists no INVALID_INPUT for this channel, and
    // there is no reason to read both tiers' files to reject a bad argument.
    if !is_valid_tier(&tier) {
        return err("RULE_NOT_FOUND", "that rule no longer exists");
    }
    let (rule, from, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if rule.tier == tier {
        return ok(list_rules(&local, global.as_deref()));
    }
    let to = if tier == "global" {
        match global.clone() {
            Some(p) => p,
            None => return err("SETTINGS_WRITE_FAILED", NO_GLOBAL),
        }
    } else {
        local.clone()
    };
    let moved = move_rule(&from, &to, &tier, &rule.effect, &rule.pattern, rule.enabled);
    if let Err(msg) = moved {
        return err("SETTINGS_WRITE_FAILED", msg);
    }
    ok(list_rules(&local, global.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-perm-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---- FR-5: pattern generation (the §9 table) ----

    #[test]
    fn bash_patterns_use_a_two_token_prefix_for_subcommand_programs() {
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        assert_eq!(p("npm test"), "Bash(npm test:*)");
        assert_eq!(p("npm test -- --watch"), "Bash(npm test:*)");
        assert_eq!(p("git commit -m 'x'"), "Bash(git commit:*)");
        assert_eq!(p("cargo build --release"), "Bash(cargo build:*)");
        // A flag second token is not a subcommand — fall back to the program.
        assert_eq!(p("git --version"), "Bash(git:*)");
        // Not a subcommand-style program — one token.
        assert_eq!(p("ls -la"), "Bash(ls:*)");
        assert_eq!(p("ls"), "Bash(ls:*)");
    }

    #[test]
    fn every_fr5_subcommand_program_is_listed() {
        // Regression: `bun` was missing, so `bun test` generated `Bash(bun:*)` —
        // "always allow" on a test run silently granting `bun install`, `bun x`,
        // `bun run <script>`. Pin the whole FR-5 list, not just a sample.
        const FR5: [&str; 30] = [
            "git", "gh", "npm", "npx", "pnpm", "yarn", "cargo", "docker", "kubectl", "go", "make",
            "uv", "pip", "pip3", "poetry", "dotnet", "bundle", "rails", "terraform", "aws",
            "gcloud", "brew", "apt", "apt-get", "systemctl", "python", "python3", "node", "deno",
            "bun",
        ];
        for prog in FR5 {
            assert!(
                SUBCOMMAND_PROGRAMS.contains(&prog),
                "FR-5 lists `{prog}` but SUBCOMMAND_PROGRAMS does not"
            );
            let cmd = format!("{prog} sub --flag");
            assert_eq!(
                generate_pattern("Bash", &json!({ "command": cmd }), "/r"),
                format!("Bash({prog} sub:*)")
            );
        }
        assert_eq!(SUBCOMMAND_PROGRAMS.len(), FR5.len());
    }

    #[test]
    fn bash_patterns_pin_the_exact_command_when_shell_operators_are_present() {
        // §7 #11: `Bash(cd x:*)` would authorize whatever rides after the `&&`.
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        assert_eq!(p("cd x && rm -rf y"), "Bash(cd x && rm -rf y)");
        assert_eq!(p("cat a | grep b"), "Bash(cat a | grep b)");
        assert_eq!(p("ls > out.txt"), "Bash(ls > out.txt)");
        assert_eq!(p("a\nb"), "Bash(a\nb)");
        assert_eq!(p("a\rb"), "Bash(a\rb)");
        // A BARE `&` separates commands exactly like `&&`. The pair-only operator
        // list let this through the PREFIX branch, so "always allow" on a test run
        // wrote `Bash(npm test:*)` — and every later `npm test & <payload>` would
        // then be auto-approved by the CLI with no card at all.
        assert_eq!(p("npm test & rm -rf y"), "Bash(npm test & rm -rf y)");
        assert_eq!(p("rm -rf $TARGET"), "Bash(rm -rf $TARGET)");
        assert_eq!(p("ls # nothing to see"), "Bash(ls # nothing to see)");
        assert_eq!(p("cat {a,b}"), "Bash(cat {a,b})");
    }

    #[test]
    fn the_exact_command_branch_never_emits_a_wildcard_or_an_ambiguous_pattern() {
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        // A command ENDING in `:*` would be re-read by Claude as a PREFIX rule —
        // the "exact pin" branch handing out a wildcard. Degrade to the bare tool
        // name, whose label reads "any Bash call": obviously too broad, so the
        // user refuses it. Failing toward refusal is safe; failing toward
        // something that LOOKS narrow while granting more is not.
        assert_eq!(p("echo a && echo b:*"), "Bash");
        // A `)` makes the pattern's own closing paren ambiguous.
        assert_eq!(p("echo $(whoami)"), "Bash");
        assert_eq!(p("(rm -rf /)"), "Bash");
        assert_eq!(label_for_pattern("Bash"), "any Bash call");
    }

    #[test]
    fn bash_without_a_command_falls_back_to_the_bare_tool() {
        assert_eq!(generate_pattern("Bash", &json!({}), "/repo"), "Bash");
        assert_eq!(
            generate_pattern("Bash", &json!({ "command": "   " }), "/repo"),
            "Bash"
        );
    }

    #[test]
    fn path_tools_scope_to_the_file_relative_to_cwd_when_inside_it() {
        assert_eq!(
            generate_pattern("Read", &json!({ "file_path": "/repo/src/a.ts" }), "/repo"),
            "Read(src/a.ts)"
        );
        assert_eq!(
            generate_pattern("Edit", &json!({ "file_path": "D:\\repo\\src\\a.ts" }), "D:\\repo"),
            "Edit(src/a.ts)"
        );
        // Outside the cwd: verbatim (with / separators) — a weak rule, but the
        // card shows the pattern before the user commits to it.
        assert_eq!(
            generate_pattern("Write", &json!({ "file_path": "/etc/hosts" }), "/repo"),
            "Write(/etc/hosts)"
        );
        assert_eq!(
            generate_pattern("Grep", &json!({ "path": "/repo/src" }), "/repo"),
            "Grep(src)"
        );
        assert_eq!(
            generate_pattern("NotebookEdit", &json!({ "notebook_path": "/repo/n.ipynb" }), "/repo"),
            "NotebookEdit(n.ipynb)"
        );
        // No path key at all → the bare tool name.
        assert_eq!(generate_pattern("Read", &json!({}), "/repo"), "Read");
    }

    #[test]
    fn webfetch_scopes_to_the_url_host() {
        let p = |url: &str| generate_pattern("WebFetch", &json!({ "url": url }), "/repo");
        assert_eq!(p("https://example.com/a/b?c=1"), "WebFetch(domain:example.com)");
        assert_eq!(p("http://user:pw@Docs.Example.COM:8080/x"), "WebFetch(domain:docs.example.com)");
        assert_eq!(generate_pattern("WebFetch", &json!({}), "/repo"), "WebFetch");
    }

    #[test]
    fn webfetch_treats_a_backslash_as_a_path_separator() {
        // WHATWG URL parsing treats `\` as `/` in a special scheme, so
        // `https://evil.com\@good.com/x` FETCHES evil.com. Splitting on `/` alone
        // reported `good.com` — the card would have read "fetch from good.com"
        // and offered that domain as the rule for a call going elsewhere.
        assert_eq!(url_host("https://evil.com\\@good.com/x").as_deref(), Some("evil.com"));
        // Anything still delimiter-ish after the split is refused, not guessed at.
        assert_eq!(url_host("https://a b.com/x"), None);
        assert_eq!(url_host("https://[::1]/x"), None);
        assert_eq!(url_host("https://"), None);
    }

    #[test]
    fn mcp_and_unknown_tools_pattern_as_themselves() {
        assert_eq!(generate_pattern("mcp__ctx7__query", &json!({}), "/r"), "mcp__ctx7__query");
        assert_eq!(generate_pattern("mcp__ctx7", &json!({}), "/r"), "mcp__ctx7");
        assert_eq!(generate_pattern("WebSearch", &json!({ "query": "x" }), "/r"), "WebSearch");
        assert_eq!(generate_pattern("Frobnicate", &json!({ "x": 1 }), "/r"), "Frobnicate");
    }

    // ---- FR-5/FR-17: labels ----

    #[test]
    fn labels_read_back_from_the_raw_pattern() {
        assert_eq!(label_for_pattern("Bash(npm test:*)"), "npm test (any arguments)");
        assert_eq!(label_for_pattern("Bash(cd x && ls)"), "run exactly this command");
        assert_eq!(label_for_pattern("Read(src/a.ts)"), "read src/a.ts");
        assert_eq!(label_for_pattern("Edit(src/a.ts)"), "edit src/a.ts");
        assert_eq!(label_for_pattern("Grep(src)"), "search src");
        assert_eq!(label_for_pattern("WebFetch(domain:example.com)"), "fetch from example.com");
        assert_eq!(label_for_pattern("mcp__ctx7__query"), "query on the ctx7 MCP server");
        assert_eq!(label_for_pattern("mcp__ctx7"), "any tool on the ctx7 MCP server");
        assert_eq!(label_for_pattern("WebSearch"), "any WebSearch call");
    }

    // ---- FR-4: card content ----

    #[test]
    fn summary_picks_the_tool_s_what_key_and_json_is_truncated() {
        assert_eq!(summarize_input("Bash", &json!({ "command": "npm test" })), "npm test");
        assert_eq!(summarize_input("Read", &json!({ "file_path": "/a/b" })), "/a/b");
        assert_eq!(summarize_input("WebFetch", &json!({ "url": "https://x" })), "https://x");
        assert_eq!(summarize_input("Frobnicate", &json!({ "x": 1 })), "");
        let big = json!({ "command": "x".repeat(9000) });
        let out = input_json(&big);
        assert!(out.chars().count() <= 4002, "truncated to 4000 + the … marker");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn build_ask_carries_the_pattern_and_its_label() {
        let ask = build_ask("Bash", &json!({ "command": "npm test" }), "/repo");
        assert_eq!(ask.tool_name, "Bash");
        assert_eq!(ask.summary, "npm test");
        assert_eq!(ask.pattern, "Bash(npm test:*)");
        assert_eq!(ask.pattern_label, "npm test (any arguments)");
        assert_eq!(ask.cwd, "/repo");
    }

    #[test]
    fn permission_ask_serializes_to_the_contract_shape() {
        let v = serde_json::to_value(build_ask("Bash", &json!({ "command": "ls" }), "/r")).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["toolName", "summary", "inputJson", "cwd", "pattern", "patternLabel"] {
            assert!(keys.contains(&k), "missing {k} in {keys:?}");
        }
        assert_eq!(keys.len(), 6);
    }

    // ---- FR-14: surgical merge ----

    #[test]
    fn merge_preserves_every_other_key_and_is_idempotent() {
        let mut doc = json!({
            "env": { "FOO": "bar" },
            "model": "opus",
            "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Bash(rm:*)"] }
        });
        assert!(merge_pattern(&mut doc, "allow", "Bash(npm test:*)"));
        assert!(!merge_pattern(&mut doc, "allow", "Bash(npm test:*)")); // §7 #1
        assert_eq!(doc["env"]["FOO"], "bar");
        assert_eq!(doc["model"], "opus");
        assert_eq!(doc["permissions"]["deny"], json!(["Bash(rm:*)"]));
        assert_eq!(
            doc["permissions"]["allow"],
            json!(["Bash(ls:*)", "Bash(npm test:*)"])
        );
    }

    #[test]
    fn merge_creates_the_permissions_object_on_a_bare_document() {
        let mut doc = json!({});
        assert!(merge_pattern(&mut doc, "deny", "Bash(rm:*)"));
        assert_eq!(doc, json!({ "permissions": { "deny": ["Bash(rm:*)"] } }));
    }

    #[test]
    fn remove_leaves_an_emptied_array_in_place() {
        let mut doc = json!({ "env": {}, "permissions": { "allow": ["A", "B"] } });
        assert!(remove_pattern(&mut doc, "allow", "A"));
        assert_eq!(doc["permissions"]["allow"], json!(["B"]));
        assert!(remove_pattern(&mut doc, "allow", "B"));
        assert_eq!(doc["permissions"]["allow"], json!([]));
        assert!(!remove_pattern(&mut doc, "allow", "B"));
        assert!(doc["env"].is_object());
    }

    #[test]
    fn non_string_entries_are_skipped_on_read_and_kept_on_write() {
        // §7 #15
        let mut doc = json!({ "permissions": { "allow": ["A", 7, { "x": 1 }] } });
        assert_eq!(patterns_of(&doc, "allow"), vec!["A".to_string()]);
        merge_pattern(&mut doc, "allow", "B");
        assert_eq!(doc["permissions"]["allow"], json!(["A", 7, { "x": 1 }, "B"]));
    }

    // ---- FR-14: read/write on disk ----

    #[test]
    fn read_json_object_treats_missing_and_empty_as_empty_and_refuses_garbage() {
        let dir = tmpdir("read");
        let missing = dir.join("nope.json");
        assert_eq!(read_json_object(&missing).unwrap(), json!({}));
        assert!(!missing.exists(), "a read never creates anything (§7 #3)");

        let empty = dir.join("empty.json");
        std::fs::write(&empty, "  \n").unwrap();
        assert_eq!(read_json_object(&empty).unwrap(), json!({}));

        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(read_json_object(&bad).is_err());

        let arr = dir.join("arr.json");
        std::fs::write(&arr, "[]").unwrap();
        assert!(read_json_object(&arr).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rule_merges_into_an_existing_file_without_clobbering_it() {
        let dir = tmpdir("write");
        let settings = dir.join(".claude").join("settings.local.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{"env":{"FOO":"bar"},"permissions":{"allow":["Bash(ls:*)"]}}"#,
        )
        .unwrap();

        let rule = write_rule(&settings, "local", "allow", "Bash(npm test:*)").unwrap();
        assert_eq!(rule.pattern, "Bash(npm test:*)");
        assert_eq!(rule.id, "local|allow|Bash(npm test:*)");
        assert_eq!(rule.label, "npm test (any arguments)");
        assert!(rule.enabled);

        let doc = read_json_object(&settings).unwrap();
        assert_eq!(doc["env"]["FOO"], "bar");
        assert_eq!(
            doc["permissions"]["allow"],
            json!(["Bash(ls:*)", "Bash(npm test:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rule_refuses_to_touch_an_unparseable_settings_file() {
        // §7 #2 / FR-7: the decision must fail BEFORE anything is claimed.
        let dir = tmpdir("garbage");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, "{ this is not json").unwrap();
        assert!(write_rule(&settings, "local", "allow", "Bash(ls:*)").is_err());
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "{ this is not json"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rule_creates_the_claude_dir_on_first_write() {
        let dir = tmpdir("mkdir");
        let settings = local_settings_path(dir.to_str().unwrap());
        assert!(!settings.parent().unwrap().exists());
        write_rule(&settings, "local", "deny", "Bash(rm:*)").unwrap();
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["deny"],
            json!(["Bash(rm:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-15/FR-17: sidecar + listing ----

    #[test]
    fn listing_orders_deny_then_ask_then_allow_and_local_before_global() {
        let dir = tmpdir("list");
        let local = dir.join("local").join("settings.local.json");
        let global = dir.join("global").join("settings.json");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::create_dir_all(global.parent().unwrap()).unwrap();
        std::fs::write(
            &local,
            r#"{"permissions":{"allow":["Bash(ls:*)"],"deny":["Bash(rm:*)"],"ask":["Bash(git push:*)"]}}"#,
        )
        .unwrap();
        std::fs::write(&global, r#"{"permissions":{"allow":["WebSearch"]}}"#).unwrap();

        let rules = list_rules(&local, Some(&global));
        let seen: Vec<(String, String, String)> = rules
            .iter()
            .map(|r| (r.effect.clone(), r.tier.clone(), r.pattern.clone()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("deny".into(), "local".into(), "Bash(rm:*)".into()),
                ("ask".into(), "local".into(), "Bash(git push:*)".into()),
                ("allow".into(), "local".into(), "Bash(ls:*)".into()),
                ("allow".into(), "global".into(), "WebSearch".into()),
            ]
        );
        assert!(rules.iter().all(|r| r.enabled));
        // §7 #14: the same pattern in both tiers is two distinct ids.
        assert_ne!(
            rule_id("local", "allow", "X"),
            rule_id("global", "allow", "X")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disabling_moves_a_pattern_into_the_sidecar_and_back() {
        let dir = tmpdir("sidecar");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();

        // off: out of settings.json, into the sidecar
        let mut doc = read_json_object(&settings).unwrap();
        assert!(remove_pattern(&mut doc, "allow", "Bash(ls:*)"));
        write_json_atomic(&settings, &doc).unwrap();
        set_disabled(&settings, "allow", "Bash(ls:*)", true).unwrap();

        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1);
        assert!(!rules[0].enabled);
        assert_eq!(rules[0].pattern, "Bash(ls:*)");
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!([])
        );

        // on: back into settings.json, out of the sidecar
        write_rule(&settings, "local", "allow", "Bash(ls:*)").unwrap();
        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1, "never listed twice");
        assert!(rules[0].enabled);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drop_rule_clears_both_the_settings_entry_and_the_sidecar() {
        let dir = tmpdir("drop");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, "{}").unwrap();
        set_disabled(&settings, "deny", "Bash(rm:*)", true).unwrap();
        assert_eq!(list_rules(&settings, None).len(), 1);
        drop_rule(&settings, "deny", "Bash(rm:*)").unwrap();
        assert!(list_rules(&settings, None).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_tier_contributes_nothing_instead_of_failing_the_listing() {
        let dir = tmpdir("tolerant");
        let local = dir.join("settings.local.json");
        let global = dir.join("global.json");
        std::fs::write(&local, "{ garbage").unwrap();
        std::fs::write(&global, r#"{"permissions":{"allow":["WebSearch"]}}"#).unwrap();
        let rules = list_rules(&local, Some(&global));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].tier, "global");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn path_scoping_never_panics_on_a_case_folding_length_change() {
        // `char::to_lowercase` is not length-preserving (`İ` U+0130 is 2 bytes and
        // lowercases to 3), so comparing on lowercased copies while slicing at the
        // ORIGINAL byte offset could land off a UTF-8 boundary and PANIC — on the
        // turn's reader thread, poisoning every pending map behind it.
        for (path, cwd) in [
            ("/İ/src/a.ts", "/i\u{307}"),
            ("/i\u{307}/src/a.ts", "/İ"),
            ("/İstanbul/x", "/İSTANBUL"),
            ("/ünïcødé/a", "/ÜNÏCØDÉ"),
        ] {
            let out = generate_pattern("Read", &json!({ "file_path": path }), cwd);
            assert!(out.starts_with("Read("), "{out}");
        }
        // ASCII case folding still scopes (the case Francois actually hits).
        assert_eq!(
            generate_pattern("Read", &json!({ "file_path": "D:/Repo/src/a.ts" }), "d:\\repo"),
            "Read(src/a.ts)"
        );
    }

    // ---- FR-14: key order ----

    #[test]
    fn a_surgical_write_preserves_the_user_s_key_order() {
        // serde_json's default Map is a BTreeMap, which would alphabetize the
        // whole document on the first "always allow". FR-14 promises to preserve
        // what it does not touch.
        let dir = tmpdir("order");
        let settings = dir.join("settings.local.json");
        std::fs::write(
            &settings,
            r#"{"zzz":1,"model":"opus","aaa":2,"permissions":{"deny":["X"]}}"#,
        )
        .unwrap();
        write_rule(&settings, "local", "allow", "Bash(ls:*)").unwrap();
        let back = std::fs::read_to_string(&settings).unwrap();
        let (z, m, a) = (
            back.find("zzz").unwrap(),
            back.find("model").unwrap(),
            back.find("aaa").unwrap(),
        );
        assert!(z < m && m < a, "keys were reordered:\n{back}");
        // …and `deny` still precedes the newly created `allow` inside permissions.
        assert!(back.find("\"deny\"").unwrap() < back.find("\"allow\"").unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-16/FR-17: no duplicate ids ----

    #[test]
    fn a_pattern_live_in_settings_and_parked_in_the_sidecar_lists_once_as_enabled() {
        // Reachable via §3 flow 7: the user disables a rule, then the CLI or a
        // hand edit re-adds it. Ids are derived (FR-16), so listing it twice would
        // give two rows the SAME id — and locate() takes the first, so a toggle or
        // a delete could act on the wrong row.
        let dir = tmpdir("dupid");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        write_disabled(&settings, &[("allow".into(), "Bash(ls:*)".into())]).unwrap();

        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1, "listed twice: {rules:?}");
        assert!(rules[0].enabled, "settings.json wins — it is what Claude enforces");
        let ids: std::collections::HashSet<&str> = rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), rules.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_sidecar_write_failure_is_reported_and_leaves_settings_json_intact() {
        // A swallowed sidecar error would leave a pattern live in settings.json
        // AND parked in the sidecar (the duplicate-id state) while reporting
        // success. Forcing a real write failure: make the sidecar PATH a
        // directory, so the temp-file rename can never land.
        let dir = tmpdir("sidefail");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        std::fs::create_dir_all(sidecar_path(&settings)).unwrap();

        let outcome = park_rule(&settings, "allow", "Bash(ls:*)");
        assert!(outcome.is_err(), "the failure must surface, not be swallowed");
        // FR-15 ordering: the sidecar write is attempted FIRST, so a failure
        // leaves the rule visible in settings.json rather than gone from both.
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!(["Bash(ls:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-15: park ordering ----

    #[test]
    fn park_rule_records_the_sidecar_entry_before_dropping_the_live_one() {
        // Ordering is the REVERSE of the obvious one on purpose: a failure between
        // the two steps must leave the rule visible in settings.json, never
        // deleted from both files.
        let dir = tmpdir("park");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        park_rule(&settings, "allow", "Bash(ls:*)").unwrap();
        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1);
        assert!(!rules[0].enabled);
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!([])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-18: setTier's move ----

    #[test]
    fn move_rule_transfers_between_tiers_preserving_enabled() {
        let dir = tmpdir("move");
        let local = dir.join("l").join("settings.local.json");
        let global = dir.join("g").join("settings.json");
        write_rule(&local, "local", "allow", "Bash(ls:*)").unwrap();

        // enabled: lands live in the destination, gone from the source
        move_rule(&local, &global, "global", "allow", "Bash(ls:*)", true).unwrap();
        let after = list_rules(&local, Some(&global));
        assert_eq!(after.len(), 1, "present in exactly one tier: {after:?}");
        assert_eq!(after[0].tier, "global");
        assert!(after[0].enabled);
        assert_eq!(after[0].id, "global|allow|Bash(ls:*)");

        // disabled: stays parked on the way back
        park_rule(&global, "allow", "Bash(ls:*)").unwrap();
        move_rule(&global, &local, "local", "allow", "Bash(ls:*)", false).unwrap();
        let back = list_rules(&local, Some(&global));
        assert_eq!(back.len(), 1, "present in exactly one tier: {back:?}");
        assert_eq!(back[0].tier, "local");
        assert!(!back[0].enabled, "enabled state must survive the move");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-6: the decision matrix ----

    #[test]
    fn decide_outcome_maps_the_four_decisions_and_rejects_anything_else() {
        assert_eq!(decide_outcome("allowOnce"), Some((true, false)));
        assert_eq!(decide_outcome("denyOnce"), Some((false, false)));
        assert_eq!(decide_outcome("allowAlways"), Some((true, true)));
        assert_eq!(decide_outcome("denyAlways"), Some((false, true)));
        for bad in ["", "allow", "AllowOnce", "allowalways", "nonsense"] {
            assert_eq!(decide_outcome(bad), None, "{bad} must be INVALID_INPUT");
        }
    }

    #[test]
    fn only_the_contract_s_two_tier_names_are_valid() {
        assert!(is_valid_tier("local"));
        assert!(is_valid_tier("global"));
        for bad in ["", "Global", "LOCAL", "project", "user"] {
            assert!(!is_valid_tier(bad), "{bad} must be rejected");
        }
    }

    // ---- FR-16: rule ids ----

    #[test]
    fn rule_ids_round_trip_even_when_the_pattern_contains_a_pipe() {
        let id = rule_id("local", "allow", "Bash(a || b)");
        assert_eq!(
            parse_rule_id(&id),
            Some((
                "local".to_string(),
                "allow".to_string(),
                "Bash(a || b)".to_string()
            ))
        );
        assert_eq!(parse_rule_id("local|nonsense|X"), None);
        assert_eq!(parse_rule_id("local|allow"), None);
    }

    // ---- FR-13: tier paths ----

    #[test]
    fn local_tier_is_the_project_s_settings_local_json() {
        let p = local_settings_path("/repo");
        assert!(p.ends_with("settings.local.json"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), ".claude");
    }
}

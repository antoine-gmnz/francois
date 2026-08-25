//! FR-1..FR-8: projects.json, root normalization, duplicate detection, ordering.

use super::*;

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// FR-8: the platform's own separator — the normalized form a root is STORED in.
#[cfg(windows)]
pub(crate) const SEP: char = '\\';
#[cfg(not(windows))]
pub(crate) const SEP: char = '/';

/// FR-6: trimmed name bounds (contract MAX_PROJECT_NAME_LENGTH).
const MAX_NAME_LENGTH: usize = 80;

/// FR-6: an empty-after-trim or over-long name. Both are `INVALID_INPUT`.
pub(crate) const BAD_NAME_MSG: &str = "a project name must be 1–80 characters";

/// Windows extended-length / device path prefixes, stripped by `normalize_root` so
/// a verbatim spelling and a plain one compare equal (FR-8).
#[cfg(windows)]
const VERBATIM_PREFIX: &str = r"\\?\";
#[cfg(windows)]
const DEVICE_PREFIX: &str = r"\\.\";

// ---------- FR-8: root normalization ----------

/// Resolve `.`/`..` LEXICALLY (never touching the filesystem — a root that does not
/// exist yet must still normalize), unify separators to the platform's, strip
/// trailing separators, and trim surrounding whitespace. A bare root (`D:\`, `/`)
/// keeps its separator; everything else loses it. Idempotent by construction.
///
/// Off Windows a backslash is a legal filename character, never a separator —
/// `Path::components` already draws that line per platform, so it does the work.
pub(crate) fn normalize_root(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Strip a Windows verbatim / device prefix before walking components. The
    // verbatim spelling of a path and its plain spelling name the SAME directory,
    // but `Path::components` reports the prefix verbatim, so the two folded to
    // different roots and BOTH could be registered — defeating FR-6's duplicate
    // check. FR-8 forbids symlink resolution, so `canonicalize()` is not an option.
    #[cfg(windows)]
    let trimmed = {
        // The UNC form re-enters as a plain `\\server\share` path.
        match trimmed
            .strip_prefix(VERBATIM_PREFIX)
            .or_else(|| trimmed.strip_prefix(DEVICE_PREFIX))
        {
            Some(rest) => match rest.strip_prefix("UNC") {
                Some(unc) => return normalize_root(&format!("{SEP}{unc}")),
                None => rest,
            },
            None => trimmed,
        }
    };
    let mut prefix = String::new(); // Windows drive or UNC share, e.g. `D:` / `\\wsl$\Ubuntu`
    let mut rooted = false;
    let mut parts: Vec<String> = Vec::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Prefix(p) => prefix = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            // A `..` with nothing to pop is dropped: it cannot escape above the root.
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
        }
    }
    let mut out = prefix;
    if rooted {
        out.push(SEP);
    }
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(SEP);
        }
        out.push_str(part);
    }
    out
}

/// A normalized root split into comparable components, case-folded on Windows and
/// case-sensitive elsewhere (FR-8). Comparison is ALWAYS component-wise, so
/// `D:\a\bc` is neither equal to nor inside `D:\a\b`.
///
/// The root marker (`D:\`, `\\share\`, `/`) is its own leading component, so two
/// paths on different drives can never share a prefix.
pub(crate) fn root_components(root: &str) -> Vec<String> {
    let norm = normalize_root(root);
    if norm.is_empty() {
        return Vec::new();
    }
    fn fold(s: String) -> String {
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut head = String::new();
    for comp in Path::new(&norm).components() {
        match comp {
            Component::Prefix(p) => head = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => {
                head.push(SEP);
                out.push(fold(std::mem::take(&mut head)));
            }
            Component::Normal(s) => out.push(fold(s.to_string_lossy().into_owned())),
            Component::CurDir | Component::ParentDir => {}
        }
    }
    // A prefix with no root dir (`D:relative`) must LEAD, not trail — appending it
    // after the loop yielded ["foo", "d:"] for `D:foo`. Unreachable through the
    // commands (validate_root rejects non-absolute paths) but same_root is public.
    if !head.is_empty() {
        out.insert(0, fold(head));
    }
    out
}

/// True when two roots name the SAME directory. An empty (invalid) root never
/// matches anything — two unusable values must not collide in the duplicate check.
pub(crate) fn same_root(a: &str, b: &str) -> bool {
    let (ca, cb) = (root_components(a), root_components(b));
    !ca.is_empty() && ca == cb
}

/// FR-2: `rootExists` — false when the path is absent or is not a directory.
pub(crate) fn root_exists(root: &str) -> bool {
    !root.is_empty() && Path::new(root).is_dir()
}

// ---------- FR-6: validation ----------

/// FR-6 step 1. Returns the NORMALIZED root to store.
pub(crate) fn validate_root(raw: &str) -> Result<String, &'static str> {
    let norm = normalize_root(raw);
    // Order matters only for the message: every failure here is the same code.
    if norm.is_empty() || !Path::new(&norm).is_absolute() || !root_exists(&norm) {
        return Err(BAD_ROOT_MSG);
    }
    Ok(norm)
}

/// FR-6: `name` defaults to the basename of `root`; a supplied name is trimmed and
/// must be non-empty and ≤ 80 chars. Names are NOT unique (§7 #25).
pub(crate) fn resolve_name(name: Option<&str>, root: &str) -> Result<String, &'static str> {
    let candidate = match name {
        Some(n) => n.trim().to_string(),
        // A bare root (`D:\`) has no basename — fall back to the root itself so the
        // project is still nameable rather than rejected.
        None => {
            let norm = normalize_root(root);
            Path::new(&norm)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or(norm)
        }
    };
    if candidate.is_empty() {
        return Err(BAD_NAME_MSG);
    }
    // Count CHARS, not bytes — an 80-emoji name is 80 characters to the user.
    if candidate.chars().count() > MAX_NAME_LENGTH {
        return Err(BAD_NAME_MSG);
    }
    Ok(candidate)
}

// ---------- FR-2/FR-5: listing ----------

pub(crate) fn meta_of(p: &Project) -> ProjectMeta {
    ProjectMeta {
        id: p.id.clone(),
        name: p.name.clone(),
        root: p.root.clone(),
        defaults: p.defaults.clone(),
        created_at: p.created_at,
        last_used_at: p.last_used_at,
        // FR-2: derived on every read, never persisted.
        root_exists: root_exists(&p.root),
        group_id: p.group_id.clone(),
    }
}

/// FR-5: `lastUsedAt` descending, ties broken by `name` ascending
/// (case-insensitive), with `rootExists` derived per entry (FR-2).
pub(crate) fn list_metas(projects: &[Project]) -> Vec<ProjectMeta> {
    let mut metas: Vec<ProjectMeta> = projects.iter().map(meta_of).collect();
    metas.sort_by(|a, b| {
        b.last_used_at
            .cmp(&a.last_used_at)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    metas
}

// ---------- project-groups FR-1/FR-4/FR-5: group entity ----------

/// FR-4: trimmed group name bounds (contract MAX_GROUP_NAME_LENGTH).
const MAX_GROUP_NAME_LENGTH: usize = 80;

/// FR-4: trimmed, 1–80 chars. Names are NOT unique — groups are keyed by id.
pub(crate) fn resolve_group_name(name: &str) -> Result<String, &'static str> {
    let candidate = name.trim().to_string();
    if candidate.is_empty() || candidate.chars().count() > MAX_GROUP_NAME_LENGTH {
        return Err(BAD_GROUP_NAME_MSG);
    }
    Ok(candidate)
}

/// FR-5: `createdAt` ascending, ties broken by `name` ascending (case-insensitive,
/// plain lowercase — matching the projects tie-break byte-for-byte).
pub(crate) fn list_groups(groups: &[ProjectGroup]) -> Vec<ProjectGroup> {
    let mut out = groups.to_vec();
    out.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// FR-1: name validation + entry construction. Not unique (FR-4).
pub(crate) fn create_group_entry(
    name: &str,
    id: String,
    now: u64,
) -> Result<ProjectGroup, (&'static str, &'static str)> {
    let name = resolve_group_name(name).map_err(|m| ("INVALID_INPUT", m))?;
    Ok(ProjectGroup {
        id,
        name,
        created_at: now,
    })
}

/// Rename: returns `(index, patched)`, mirroring `patch_entry`'s shape.
pub(crate) fn rename_group_entry(
    groups: &[ProjectGroup],
    group_id: &str,
    name: &str,
) -> Result<(usize, ProjectGroup), (&'static str, &'static str)> {
    let idx = groups
        .iter()
        .position(|g| g.id == group_id)
        .ok_or(("GROUP_NOT_FOUND", GROUP_NOT_FOUND_MSG))?;
    let mut patched = groups[idx].clone();
    patched.name = resolve_group_name(name).map_err(|m| ("INVALID_INPUT", m))?;
    Ok((idx, patched))
}

pub(crate) fn group_exists(groups: &[ProjectGroup], group_id: &str) -> bool {
    groups.iter().any(|g| g.id == group_id)
}

/// FR-7: sets or clears a project's `groupId`. A `groupId` naming an unknown
/// group is rejected — the core re-validates against the live registry rather
/// than trusting the frontend's list.
pub(crate) fn assign_group_entry(
    projects: &[Project],
    groups: &[ProjectGroup],
    project_id: &str,
    group_id: Option<&str>,
) -> Result<(usize, Project), (&'static str, &'static str)> {
    let idx = projects
        .iter()
        .position(|p| p.id == project_id)
        .ok_or(("PROJECT_NOT_FOUND", NOT_FOUND_MSG))?;
    if let Some(gid) = group_id {
        if !group_exists(groups, gid) {
            return Err(("GROUP_NOT_FOUND", GROUP_NOT_FOUND_MSG));
        }
    }
    let mut patched = projects[idx].clone();
    patched.group_id = group_id.map(str::to_string);
    Ok((idx, patched))
}

/// FR-8: the delete sweep — clears `groupId` on every member. Pure half, so it
/// is unit-testable without an AppHandle (mirrors `clear_default_from`).
pub(crate) fn clear_group_from(projects: &mut [Project], group_id: &str) -> usize {
    let mut cleared = 0;
    for p in projects.iter_mut() {
        if p.group_id.as_deref() == Some(group_id) {
            p.group_id = None;
            cleared += 1;
        }
    }
    cleared
}

/// I/O half of FR-8 — best-effort, run AFTER the group's own removal has
/// committed (mirrors `clear_default`'s "memory and disk agree" contract). A
/// persist failure here is logged and rolled back in memory; the group's
/// removal already stands regardless (FR-8 applies verbatim).
pub(crate) fn clear_group(app: &AppHandle, group_id: &str) {
    let Some(state) = app.try_state::<ProjectRegistry>() else {
        return;
    };
    let mut doc = state.doc.lock().unwrap();
    let snapshot = doc.projects.clone();
    if clear_group_from(&mut doc.projects, group_id) == 0 {
        return; // no project referenced it — do not rewrite the file
    }
    if let Err(msg) = persist(app, &doc.projects, &doc.groups) {
        eprintln!("projects: could not persist group-removal sweep: {msg}");
        doc.projects = snapshot;
    }
}

// ---------- FR-6/FR-7: pure decision functions behind the command glue ----------
//
// The handlers in commands.rs are lock -> delegate -> map-error glue; every actual
// decision lives here so it can be unit-tested without a Tauri AppHandle (Cargo does
// not enable tauri's `test` feature, so handler-level tests are not available).
//
// Both take an ALREADY-NORMALIZED, already-stat'ed root: the filesystem check runs
// in the handler BEFORE the registry lock is taken, so a dead UNC share can never
// stall every other project command while holding the mutex.

/// FR-6: the duplicate check + name resolution + entry construction.
pub(crate) fn create_entry(
    projects: &[Project],
    root: &str,
    name: Option<&str>,
    defaults: Option<ProjectDefaults>,
    id: String,
    now: u64,
) -> Result<Project, (&'static str, &'static str)> {
    if projects.iter().any(|p| same_root(&p.root, root)) {
        return Err(("PROJECT_DUPLICATE_ROOT", DUPLICATE_ROOT_MSG)); // §7 #2
    }
    let name = resolve_name(name, root).map_err(|m| ("INVALID_INPUT", m))?;
    Ok(Project {
        id,
        name,
        root: root.to_string(),
        defaults: defaults.unwrap_or_default(),
        created_at: now,
        last_used_at: now, // FR-4: set on creation, then only FR-20 touches it
        group_id: None,    // FR-6: a new project is always created ungrouped
    })
}

/// FR-7: patch only the present fields, returning `(index, patched)`.
/// A present `defaults` REPLACES the whole object — that is how "inherit" is restored.
pub(crate) fn patch_entry(
    projects: &[Project],
    id: &str,
    name: Option<&str>,
    root: Option<&str>,
    defaults: Option<ProjectDefaults>,
) -> Result<(usize, Project), (&'static str, &'static str)> {
    let idx = projects
        .iter()
        .position(|p| p.id == id)
        .ok_or(("PROJECT_NOT_FOUND", NOT_FOUND_MSG))?;
    let mut patched = projects[idx].clone();
    if let Some(root) = root {
        // The duplicate check EXCLUDES the project itself, so re-saving a project
        // with its own root must succeed (FR-7).
        if projects
            .iter()
            .enumerate()
            .any(|(i, p)| i != idx && same_root(&p.root, root))
        {
            return Err(("PROJECT_DUPLICATE_ROOT", DUPLICATE_ROOT_MSG));
        }
        patched.root = root.to_string();
    }
    if let Some(raw) = name {
        // Names are not unique (§7 #25) — only shape is validated.
        patched.name = resolve_name(Some(raw), &patched.root).map_err(|m| ("INVALID_INPUT", m))?;
    }
    if let Some(d) = defaults {
        patched.defaults = d;
    }
    Ok((idx, patched))
}

/// The root a standards read/write should target. `PROJECT_NOT_FOUND` takes
/// precedence over `PROJECT_ROOT_MISSING` (§7 #13).
pub(crate) fn root_of(
    projects: &[Project],
    id: &str,
) -> Result<String, (&'static str, &'static str)> {
    let p = projects
        .iter()
        .find(|p| p.id == id)
        .ok_or(("PROJECT_NOT_FOUND", NOT_FOUND_MSG))?;
    if !root_exists(&p.root) {
        return Err(("PROJECT_ROOT_MISSING", ROOT_MISSING_MSG));
    }
    Ok(p.root.clone())
}

// ---------- FR-19: the session link check ----------

pub(crate) fn validate_link(
    projects: &[Project],
    id: &str,
) -> Result<(), (&'static str, &'static str)> {
    // §7 #13: an id removed a moment earlier reports NOT_FOUND, not ROOT_MISSING.
    let Some(p) = projects.iter().find(|p| p.id == id) else {
        return Err(("PROJECT_NOT_FOUND", NOT_FOUND_MSG));
    };
    if !root_exists(&p.root) {
        return Err(("PROJECT_ROOT_MISSING", ROOT_MISSING_MSG));
    }
    Ok(())
}

// ---------- FR-1/FR-3: persistence ----------

pub(crate) fn projects_json_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("projects.json"))
}

/// FR-3: a missing, empty or unparseable document yields an EMPTY registry and is
/// not an error; a single undeserializable entry is skipped, not fatal.
pub(crate) fn parse_registry(bytes: &[u8]) -> Vec<Project> {
    // Anything that is not our `{ version, projects: [...] }` shape — including a
    // bare array from some other tool — reads as empty rather than throwing.
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(list) = doc.get("projects").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| serde_json::from_value::<Project>(entry.clone()).ok())
        .collect()
}

pub(crate) fn load_from(path: &Path) -> Vec<Project> {
    std::fs::read(path)
        .map(|b| parse_registry(&b))
        .unwrap_or_default()
}

/// project-groups FR-3: a document with no `groups` key loads as an empty list
/// and is not an error; a single undeserializable entry is skipped, not fatal —
/// mirroring `parse_registry` byte-for-byte.
pub(crate) fn parse_groups(bytes: &[u8]) -> Vec<ProjectGroup> {
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(list) = doc.get("groups").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| serde_json::from_value::<ProjectGroup>(entry.clone()).ok())
        .collect()
}

pub(crate) fn load_groups_from(path: &Path) -> Vec<ProjectGroup> {
    std::fs::read(path)
        .map(|b| parse_groups(&b))
        .unwrap_or_default()
}

/// FR-1/project-groups FR-2: `{ "version": 1, "projects": [ … ], "groups": [ … ] }`,
/// written atomically through the same helper permission-guardrails uses — one
/// document, one writer, one whole-document save for both arrays.
pub(crate) fn save_to(
    path: &Path,
    projects: &[Project],
    groups: &[ProjectGroup],
) -> Result<(), String> {
    let doc = serde_json::json!({ "version": 1, "projects": projects, "groups": groups });
    crate::permissions::write_json_atomic(path, &doc)
}

/// Writes the WHOLE registry atomically (FR-10) — the only I/O half every
/// mutation, project or group, funnels through.
pub(crate) fn persist(
    app: &AppHandle,
    projects: &[Project],
    groups: &[ProjectGroup],
) -> Result<(), String> {
    let path = projects_json_path(app)
        .ok_or_else(|| "could not resolve the app data directory".to_string())?;
    save_to(&path, projects, groups)
}

/// FR-10: the shared "swap the slot for `next`, persist, roll back on failure"
/// shape every mutation commit uses — factored out ONCE so the discipline cannot
/// drift between call sites (project and group commits, plus the cross-domain
/// sweeps below), and so it is unit-testable with a real, failing `write` without
/// needing a Tauri AppHandle (see the tests module).
pub(crate) fn commit_with<T, F>(slot: &mut Vec<T>, next: Vec<T>, write: F) -> Result<(), String>
where
    F: FnOnce(&[T]) -> Result<(), String>,
{
    let previous = std::mem::replace(slot, next);
    match write(slot) {
        Ok(()) => Ok(()),
        Err(msg) => {
            *slot = previous;
            Err(msg)
        }
    }
}

/// Load the registry once, at startup. Must run BEFORE `session::load_persisted`,
/// which prunes session links against it (FR-18).
pub fn load_projects(app: &AppHandle) {
    let Some(path) = projects_json_path(app) else {
        return;
    };
    let loaded = load_from(&path);
    let loaded_groups = load_groups_from(&path);
    if let Some(state) = app.try_state::<ProjectRegistry>() {
        let mut doc = state.doc.lock().unwrap();
        doc.projects = loaded;
        doc.groups = loaded_groups;
    }
}

/// The ids the registry currently knows — FR-18's "does this link still resolve".
pub fn known_ids(app: &AppHandle) -> HashSet<String> {
    app.try_state::<ProjectRegistry>()
        .map(|s| {
            s.doc
                .lock()
                .unwrap()
                .projects
                .iter()
                .map(|p| p.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// FR-20: refresh `lastUsedAt` after a session was created under this project.
/// A persist failure is logged and IGNORED — it must never fail session creation.
pub fn touch_last_used(app: &AppHandle, project_id: &str) {
    let Some(state) = app.try_state::<ProjectRegistry>() else {
        return;
    };
    let mut doc = state.doc.lock().unwrap();
    let Some(p) = doc.projects.iter_mut().find(|p| p.id == project_id) else {
        return;
    };
    // Roll back on a persist failure, matching commit_with's "memory and disk
    // agree" contract. FR-20 requires the CALL not to fail, not that the bump be
    // kept — keeping it would silently reorder project_list (FR-5) against a disk
    // that never recorded it.
    let previous = p.last_used_at;
    p.last_used_at = crate::session::now_ms();
    let groups = doc.groups.clone();
    if let Err(msg) = persist(app, &doc.projects, &groups) {
        eprintln!("projects: could not persist lastUsedAt: {msg}");
        if let Some(p) = doc.projects.iter_mut().find(|p| p.id == project_id) {
            p.last_used_at = previous;
        }
    }
}

// ---------- cross-domain writes (session-profiles, multi-account) ----------
//
// A project default that names a row in ANOTHER registry (a profile, an account)
// is cleared here when that row is deleted, so projects.json stops accumulating
// references to things that are gone. Both sweeps share one loop and one persist
// path — they differ only in which `Option<String>` they null out.

/// Pure half, so a sweep is unit-testable without an AppHandle. `field` picks the
/// default to clear; returns how many projects changed.
fn clear_default_from<F>(projects: &mut [Project], id: &str, field: F) -> usize
where
    F: Fn(&mut ProjectDefaults) -> &mut Option<String>,
{
    let mut cleared = 0;
    for p in projects.iter_mut() {
        let slot = field(&mut p.defaults);
        if slot.as_deref() == Some(id) {
            *slot = None;
            cleared += 1;
        }
    }
    cleared
}

// The production sweep calls the generic `clear_default_from` directly; these
// two named wrappers exist so the unit tests can pin each field's behaviour.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn clear_profile_from(projects: &mut [Project], profile_id: &str) -> usize {
    clear_default_from(projects, profile_id, |d| &mut d.profile_id)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn clear_account_from(projects: &mut [Project], account_id: &str) -> usize {
    clear_default_from(projects, account_id, |d| &mut d.account_id)
}

/// I/O half, shared by both sweeps.
///
/// Deliberately BEST-EFFORT — it never reports failure to its caller, and both
/// callers run it AFTER the row's own removal has committed. The worst case is a
/// project still naming an id that no longer resolves, which both modals already
/// drop silently when they resolve a default (session-profiles FR-21,
/// multi-account FR-20). Failing (or rolling back) the removal over a
/// project-registry write would be the worse trade: it would refuse the thing the
/// user actually asked for to protect a reference that is harmless when stale.
fn clear_default<F>(app: &AppHandle, id: &str, what: &str, field: F)
where
    F: Fn(&mut ProjectDefaults) -> &mut Option<String>,
{
    let Some(state) = app.try_state::<ProjectRegistry>() else {
        return;
    };
    let mut doc = state.doc.lock().unwrap();
    let snapshot = doc.projects.clone();
    if clear_default_from(&mut doc.projects, id, field) == 0 {
        return; // no project referenced it — do not rewrite the file
    }
    // Roll memory back on a persist failure, matching commit_with's "memory and
    // disk agree" contract: a cleared default that never reached disk would
    // reappear on the next launch and disagree with what the UI just showed.
    if let Err(msg) = persist(app, &doc.projects, &doc.groups) {
        eprintln!("projects: could not persist cleared default {what}: {msg}");
        doc.projects = snapshot;
    }
}

/// Called by `profiles_remove` once the profile is gone.
pub fn clear_default_profile(app: &AppHandle, profile_id: &str) {
    clear_default(app, profile_id, "profile", |d| &mut d.profile_id)
}

/// Called by `account_remove` once the account row and its config dir are gone.
pub fn clear_default_account(app: &AppHandle, account_id: &str) {
    clear_default(app, account_id, "account", |d| &mut d.account_id)
}

/// Boot-time reconcile: drop any project default naming a profile or account
/// that no longer exists. The delete-time sweeps above keep the registry clean
/// from now on; this catches references stranded BEFORE those existed (or by a
/// clear that could not be persisted).
///
/// Pure half. `None` for a set means "this registry could not be trusted this
/// run" and its field is left completely alone — see `reconcile_defaults` for
/// why that distinction is load-bearing. Returns how many fields were cleared.
pub(crate) fn reconcile_defaults_in(
    projects: &mut [Project],
    profile_ids: Option<&HashSet<String>>,
    account_ids: Option<&HashSet<String>>,
) -> usize {
    let mut cleared = 0;
    for p in projects.iter_mut() {
        if let (Some(known), Some(id)) = (profile_ids, p.defaults.profile_id.as_deref()) {
            if !known.contains(id) {
                p.defaults.profile_id = None;
                cleared += 1;
            }
        }
        if let (Some(known), Some(id)) = (account_ids, p.defaults.account_id.as_deref()) {
            if !known.contains(id) {
                p.defaults.account_id = None;
                cleared += 1;
            }
        }
    }
    cleared
}

/// Called once at startup, AFTER both `account::load_accounts` and
/// `profiles::load_profiles` — it validates against what they loaded, so running
/// it earlier would invalidate every id.
///
/// A registry is only trusted to invalidate references when it came back
/// NON-EMPTY, because an empty result is ambiguous: `parse_registry` yields
/// nothing both for "genuinely none" and for a corrupt or unreadable file. Given
/// that ambiguity the two errors are not symmetric — wrongly keeping a stale id
/// costs an `(unavailable)` label in one modal, while wrongly clearing valid ids
/// silently destroys every project's configuration on a transient read failure.
/// So an empty registry clears nothing. For accounts, "non-empty" means at least
/// one REGISTERED account: `known_ids` always contains the built-in id, so its
/// presence proves nothing about whether accounts.json was read.
pub fn reconcile_defaults(app: &AppHandle) {
    let Some(state) = app.try_state::<ProjectRegistry>() else {
        return;
    };
    let profile_ids = crate::profiles::known_ids(app);
    let account_ids = crate::account::known_ids(app);
    let trusted_profiles = (!profile_ids.is_empty()).then_some(&profile_ids);
    let trusted_accounts = (account_ids.len() > 1).then_some(&account_ids);
    if trusted_profiles.is_none() && trusted_accounts.is_none() {
        return;
    }

    let mut doc = state.doc.lock().unwrap();
    let snapshot = doc.projects.clone();
    if reconcile_defaults_in(&mut doc.projects, trusted_profiles, trusted_accounts) == 0 {
        return; // nothing stale — do not rewrite the file at every launch
    }
    if let Err(msg) = persist(app, &doc.projects, &doc.groups) {
        eprintln!("projects: could not persist reconciled defaults: {msg}");
        doc.projects = snapshot;
    }
}

// ---------- cross-domain lookups (cloud-sessions) ----------

/// Everything a session created OUTSIDE the new-session modal needs from a
/// project: its root, plus the defaults the modal would otherwise have
/// pre-filled. cloud-sessions FR-5/FR-10 is the only such path — an adoption has
/// no modal to read them from, so the core applies the project's own snapshot
/// rather than inventing a configuration the user never chose.
pub struct SessionSeed {
    pub root: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub runtime: Option<String>,
    pub allow_git: Option<bool>,
    pub account_id: Option<String>,
    /// response-mode FR-16: carried like every other default, so an adopted
    /// session opens on the mode the project asks for rather than on one the
    /// user never chose. Verbatim; the caller re-validates it.
    pub response_mode: Option<String>,
}

/// `None` ⇔ the id is not in the registry (`PROJECT_NOT_FOUND` at the call
/// site). A root that no longer exists is NOT filtered here: the caller's own
/// git-repo check reports that, and with a message that names the real problem.
///
/// Pure half, per this file's rule (see FR-6/FR-7 above): the decision is
/// unit-tested without a Tauri AppHandle, the wrapper below is lock-and-delegate.
pub(crate) fn seed_of(projects: &[Project], project_id: &str) -> Option<SessionSeed> {
    let p = projects.iter().find(|p| p.id == project_id)?;
    Some(SessionSeed {
        root: p.root.clone(),
        model_id: p.defaults.model_id.clone(),
        effort: p.defaults.effort.clone(),
        permission_mode: p.defaults.permission_mode.clone(),
        runtime: p.defaults.runtime.clone(),
        allow_git: p.defaults.allow_git,
        account_id: p.defaults.account_id.clone(),
        response_mode: p.defaults.response_mode.clone(),
    })
}

pub fn session_seed(app: &AppHandle, project_id: &str) -> Option<SessionSeed> {
    let state = app.try_state::<ProjectRegistry>()?;
    let doc = state.doc.lock().ok()?;
    seed_of(&doc.projects, project_id)
}

/// `(id, root)` for every registered project, in registry order.
pub(crate) fn roots_of(projects: &[Project]) -> Vec<(String, String)> {
    projects
        .iter()
        .map(|p| (p.id.clone(), p.root.clone()))
        .collect()
}

/// `(id, root)` for every registered project — cloud-sessions FR-3 walks these
/// to find the checkout of the repository a cloud session names.
pub fn project_roots(app: &AppHandle) -> Vec<(String, String)> {
    app.try_state::<ProjectRegistry>()
        .map(|s| roots_of(&s.doc.lock().unwrap().projects))
        .unwrap_or_default()
}

/// FR-19: validate a `session_create` link against the live registry.
pub fn check_session_link(
    app: &AppHandle,
    project_id: &str,
) -> Result<(), (&'static str, &'static str)> {
    match app.try_state::<ProjectRegistry>() {
        Some(state) => validate_link(&state.doc.lock().unwrap().projects, project_id),
        None => Err(("PROJECT_NOT_FOUND", NOT_FOUND_MSG)),
    }
}

/// unbound-panes FR-6/§5: the root a project-owned shell spawns at.
/// `PROJECT_NOT_FOUND` takes precedence over `PROJECT_ROOT_MISSING`, both
/// checked before the `shell` domain spawns anything — wraps `root_of` with
/// the app-handle lookup the `shell` domain (a different domain) needs.
pub fn root_for_shell(
    app: &AppHandle,
    project_id: &str,
) -> Result<String, (&'static str, &'static str)> {
    match app.try_state::<ProjectRegistry>() {
        Some(state) => root_of(&state.doc.lock().unwrap().projects, project_id),
        None => Err(("PROJECT_NOT_FOUND", NOT_FOUND_MSG)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::testutil::*;
    use serde_json::json;

    // ---- FR-8: normalization ----

    #[test]
    fn normalization_resolves_dot_segments_and_strips_trailing_separators() {
        let sep = SEP.to_string();
        let base = if cfg!(windows) { "D:\\a\\b" } else { "/a/b" };
        for raw in [
            format!("{base}{sep}"),
            format!("{base}{sep}{sep}"),
            format!("{base}{sep}.{sep}"),
            format!("{base}{sep}c{sep}..{sep}"),
            format!("  {base}  "),
        ] {
            assert_eq!(normalize_root(&raw), base, "raw: {raw:?}");
        }
        // idempotent — the stored form normalizes to itself
        assert_eq!(normalize_root(&normalize_root(base)), base);
        assert_eq!(normalize_root(""), "");
        assert_eq!(normalize_root("   "), "");
    }

    #[cfg(windows)]
    #[test]
    fn windows_normalization_unifies_separators_and_keeps_unc_prefixes() {
        assert_eq!(normalize_root("D:/a/b/"), "D:\\a\\b");
        assert_eq!(
            normalize_root("\\\\wsl$\\Ubuntu\\home\\u\\"),
            "\\\\wsl$\\Ubuntu\\home\\u"
        );
        assert_eq!(normalize_root("D:\\"), "D:\\");
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_normalization_keeps_the_root_and_never_touches_backslashes() {
        assert_eq!(normalize_root("/"), "/");
        // a backslash is a legal filename character off Windows — never a separator
        assert_eq!(normalize_root("/a/b\\c"), "/a/b\\c");
    }

    #[test]
    fn root_comparison_is_component_wise() {
        // §9 / FR-8: `D:\a\bc` is NOT `D:\a\b`, and is not inside it either.
        let (short, long) = if cfg!(windows) {
            ("D:\\a\\b", "D:\\a\\bc")
        } else {
            ("/a/b", "/a/bc")
        };
        assert!(!same_root(short, long));
        assert!(!root_components(long).starts_with(&root_components(short)));
        // a real child IS component-wise inside its parent
        let child = format!("{short}{SEP}c");
        assert!(root_components(&child).starts_with(&root_components(short)));
        // equality survives a denormalized spelling
        assert!(same_root(short, &format!("{short}{SEP}c{SEP}..")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_comparison_is_case_insensitive() {
        // §7 #21: `D:\Repo` and `D:\repo` are the same directory on Windows.
        assert!(same_root("D:\\Repo", "D:\\repo"));
        assert!(same_root("d:/REPO/sub/", "D:\\repo\\Sub"));
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_root_comparison_is_case_sensitive() {
        // §7 #21: on Linux/macOS `/Repo` and `/repo` are two distinct directories.
        assert!(!same_root("/Repo", "/repo"));
        assert!(same_root("/repo", "/repo/sub/.."));
    }

    // ---- FR-6: validation ----

    #[test]
    fn root_validation_requires_an_existing_absolute_directory() {
        let dir = tmp_root("validate");
        let raw = dir.to_string_lossy().to_string();
        assert_eq!(validate_root(&raw), Ok(normalize_root(&raw)));
        // trailing separator and dot segments are accepted and normalized away
        assert_eq!(
            validate_root(&format!("{raw}{SEP}")),
            Ok(normalize_root(&raw))
        );

        assert_eq!(validate_root(""), Err(BAD_ROOT_MSG));
        assert_eq!(validate_root("   "), Err(BAD_ROOT_MSG));
        assert_eq!(validate_root("relative/path"), Err(BAD_ROOT_MSG));
        assert_eq!(validate_root(&missing_root("validate")), Err(BAD_ROOT_MSG));

        // a FILE is not a directory
        let file = dir.join("CLAUDE.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            validate_root(&file.to_string_lossy()),
            Err(BAD_ROOT_MSG),
            "a file is not a project root"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn name_defaults_to_the_basename_and_is_trimmed_and_bounded() {
        let root = if cfg!(windows) {
            "D:\\code\\francois"
        } else {
            "/code/francois"
        };
        assert_eq!(resolve_name(None, root), Ok("francois".to_string()));
        assert_eq!(resolve_name(Some("  core  "), root), Ok("core".to_string()));
        assert!(resolve_name(Some("   "), root).is_err());
        assert!(resolve_name(Some(&"x".repeat(80)), root).is_ok());
        assert!(resolve_name(Some(&"x".repeat(81)), root).is_err());
    }

    // ---- FR-3: load tolerance ----

    #[test]
    fn a_missing_empty_or_corrupt_registry_loads_as_empty() {
        // §7 #1: never an error — the app starts, the first write recreates the file.
        let dir = tmp_root("tolerant");
        assert!(load_from(&dir.join("nope.json")).is_empty());
        assert!(parse_registry(b"").is_empty());
        assert!(parse_registry(b"   \n").is_empty());
        assert!(parse_registry(b"{ not json").is_empty());
        assert!(
            parse_registry(b"[]").is_empty(),
            "the array shape is not ours"
        );
        assert!(parse_registry(br#"{"version":1}"#).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_undeserializable_entry_is_skipped_not_fatal() {
        let good = if cfg!(windows) { "D:\\a" } else { "/a" };
        let doc = json!({
            "version": 1,
            "projects": [
                { "id": "p1", "name": "keep", "root": good, "createdAt": 1, "lastUsedAt": 2 },
                { "name": "no id at all", "root": good },
                "not even an object",
                { "id": "p2", "name": "also keep", "root": good },
            ]
        });
        let loaded = parse_registry(doc.to_string().as_bytes());
        assert_eq!(
            loaded.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["p1", "p2"]
        );
        // missing timestamps degrade to 0 rather than dropping the entry
        assert_eq!(loaded[1].last_used_at, 0);
    }

    // ---- FR-1/FR-2: the persisted document ----

    #[test]
    fn the_registry_round_trips_and_never_persists_root_exists() {
        let dir = tmp_root("roundtrip");
        let path = dir.join("projects.json");
        let projects = vec![
            project_fixture("p1", "francois", &dir.to_string_lossy(), 40),
            project_fixture("p2", "api", &dir.to_string_lossy(), 10),
        ];
        save_to(&path, &projects, &[]).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["projects"].as_array().unwrap().len(), 2);
        assert_eq!(doc["projects"][0]["createdAt"], 1_000);
        assert_eq!(doc["projects"][0]["lastUsedAt"], 40);
        assert!(
            !raw.contains("rootExists"),
            "FR-2: rootExists is derived, never persisted:\n{raw}"
        );
        // defaults with every field unset serialize as an empty object ("inherit")
        assert_eq!(doc["projects"][0]["defaults"], json!({}));
        assert_eq!(load_from(&path), projects);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_meta_serializes_to_the_contract_shape() {
        let dir = tmp_root("meta");
        let mut p = project_fixture("p1", "francois", &dir.to_string_lossy(), 40);
        p.defaults = ProjectDefaults {
            model_id: Some("opus".into()),
            effort: None,
            permission_mode: Some("acceptEdits".into()),
            runtime: None,
            allow_git: Some(true),
            account_id: Some("a1".into()),
            profile_id: None,
            response_mode: None,
        };
        let v = serde_json::to_value(meta_of(&p)).unwrap();
        assert_eq!(v["id"], "p1");
        assert_eq!(v["name"], "francois");
        assert_eq!(v["createdAt"], 1_000);
        assert_eq!(v["lastUsedAt"], 40);
        assert_eq!(v["rootExists"], true);
        assert_eq!(v["defaults"]["modelId"], "opus");
        assert_eq!(v["defaults"]["permissionMode"], "acceptEdits");
        assert_eq!(v["defaults"]["allowGit"], true);
        assert_eq!(v["defaults"]["accountId"], "a1");
        // an unset default is an OMITTED key, never null — that is how the modal
        // tells "inherit" from "explicitly set".
        assert!(v["defaults"].get("effort").is_none());
        assert!(v["defaults"].get("runtime").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_projects_account_default_survives_the_update_round_trip() {
        // multi-account FR-20: the frontend sends `defaults.accountId` on
        // project_update. Before this field existed on the Rust mirror serde
        // dropped it silently, so the Projects-modal ACCOUNT select reverted to
        // "inherit" on the next list — the select looked inert.
        let sent: ProjectDefaults =
            serde_json::from_value(json!({ "modelId": "opus", "accountId": "a1" })).unwrap();
        assert_eq!(sent.account_id.as_deref(), Some("a1"));
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            json!({ "modelId": "opus", "accountId": "a1" })
        );
        // "inherit" stays an omitted key, never a null or an empty string.
        let cleared: ProjectDefaults =
            serde_json::from_value(json!({ "modelId": "opus" })).unwrap();
        assert_eq!(cleared.account_id, None);
        assert!(serde_json::to_value(&cleared)
            .unwrap()
            .get("accountId")
            .is_none());
    }

    #[test]
    fn a_projects_profile_default_survives_the_update_round_trip() {
        // session-profiles FR-20/FR-21: the frontend sends `defaults.profileId`
        // on project_update. Exactly the accountId bug above — without the field
        // on the Rust mirror serde drops it, so the Projects-modal PROFILE select
        // reverts to "inherit" on the next list and a project can never be given
        // a default profile.
        let sent: ProjectDefaults =
            serde_json::from_value(json!({ "modelId": "opus", "profileId": "pr1" })).unwrap();
        assert_eq!(sent.profile_id.as_deref(), Some("pr1"));
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            json!({ "modelId": "opus", "profileId": "pr1" })
        );
        // "inherit" stays an omitted key, never a null or an empty string.
        let cleared: ProjectDefaults =
            serde_json::from_value(json!({ "modelId": "opus" })).unwrap();
        assert_eq!(cleared.profile_id, None);
        assert!(serde_json::to_value(&cleared)
            .unwrap()
            .get("profileId")
            .is_none());
    }

    // ---- FR-2/FR-5: listing ----

    #[test]
    fn listing_orders_by_last_used_desc_then_name_asc_and_derives_root_exists() {
        let dir = tmp_root("listing");
        let live = dir.to_string_lossy().to_string();
        let gone = missing_root("listing");
        let projects = vec![
            project_fixture("p1", "zulu", &live, 100),
            project_fixture("p2", "Bravo", &live, 500),
            project_fixture("p3", "alpha", &gone, 500),
            project_fixture("p4", "mike", &live, 900),
        ];
        let metas = list_metas(&projects);
        assert_eq!(
            metas.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["p4", "p3", "p2", "p1"],
            "lastUsedAt desc, then name asc case-insensitively"
        );
        assert!(metas[0].root_exists);
        assert!(
            !metas[1].root_exists,
            "a renamed-away folder reports missing"
        );

        // a FILE at the root path is not a directory either
        let file = dir.join("CLAUDE.md");
        std::fs::write(&file, "x").unwrap();
        let as_file = vec![project_fixture("p5", "f", &file.to_string_lossy(), 1)];
        assert!(!list_metas(&as_file)[0].root_exists);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-19: the session link check ----

    #[test]
    fn session_link_validation_reports_not_found_then_root_missing() {
        let dir = tmp_root("link");
        let projects = vec![
            project_fixture("p1", "live", &dir.to_string_lossy(), 1),
            project_fixture("p2", "gone", &missing_root("link"), 1),
        ];
        assert_eq!(validate_link(&projects, "p1"), Ok(()));
        assert_eq!(
            validate_link(&projects, "p2"),
            Err(("PROJECT_ROOT_MISSING", ROOT_MISSING_MSG))
        );
        // §7 #13: removed a moment earlier
        assert_eq!(
            validate_link(&projects, "nope"),
            Err(("PROJECT_NOT_FOUND", NOT_FOUND_MSG))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- cross-domain lookups (cloud-sessions FR-3/FR-5/FR-10) ----

    #[test]
    fn the_session_seed_carries_the_projects_root_and_every_default() {
        // cloud-sessions has no new-session modal to read these from, so an
        // adoption applies THIS snapshot — a field dropped here is a default the
        // user configured and the adopted session silently ignores.
        let mut p = project_fixture(
            "p1",
            "api",
            if cfg!(windows) { "D:\\api" } else { "/api" },
            7,
        );
        p.defaults = ProjectDefaults {
            model_id: Some("claude-opus-4".into()),
            effort: Some("high".into()),
            permission_mode: Some("plan".into()),
            runtime: Some("wsl".into()),
            allow_git: Some(true),
            account_id: Some("acct-2".into()),
            profile_id: Some("pr1".into()),
            response_mode: Some("concise".into()),
        };
        let root = p.root.clone();
        let projects = vec![p];

        let seed = seed_of(&projects, "p1").expect("a known id seeds");
        assert_eq!(seed.root, root);
        assert_eq!(seed.model_id.as_deref(), Some("claude-opus-4"));
        assert_eq!(seed.effort.as_deref(), Some("high"));
        assert_eq!(seed.permission_mode.as_deref(), Some("plan"));
        assert_eq!(seed.runtime.as_deref(), Some("wsl"));
        assert_eq!(seed.allow_git, Some(true));
        assert_eq!(seed.account_id.as_deref(), Some("acct-2"));
        assert_eq!(seed.response_mode.as_deref(), Some("concise"));

        // An all-inherit project seeds every default as absent rather than as a
        // value the core invented.
        let bare = vec![project_fixture("p2", "web", &root, 1)];
        let seed = seed_of(&bare, "p2").expect("seeds");
        assert_eq!(seed.model_id, None);
        assert_eq!(seed.effort, None);
        assert_eq!(seed.permission_mode, None);
        assert_eq!(seed.runtime, None);
        assert_eq!(seed.allow_git, None);
        assert_eq!(seed.account_id, None);
    }

    #[test]
    fn an_unknown_id_seeds_nothing_so_the_caller_reports_project_not_found() {
        let projects = vec![project_fixture(
            "p1",
            "api",
            if cfg!(windows) { "D:\\api" } else { "/api" },
            1,
        )];
        assert!(seed_of(&projects, "nope").is_none());
        assert!(seed_of(&[], "p1").is_none());
    }

    #[test]
    fn project_roots_lists_every_registered_pair_and_an_empty_registry_lists_none() {
        let (a, b) = if cfg!(windows) {
            ("D:\\api", "D:\\web")
        } else {
            ("/api", "/web")
        };
        assert_eq!(roots_of(&[]), Vec::new());
        let projects = vec![
            project_fixture("p1", "api", a, 2),
            project_fixture("p2", "web", b, 1),
        ];
        assert_eq!(
            roots_of(&projects),
            vec![
                ("p1".to_string(), normalize_root(a)),
                ("p2".to_string(), normalize_root(b)),
            ]
        );
    }

    // ---- project-groups FR-2/FR-3: persistence ----

    #[test]
    fn a_document_with_no_groups_key_loads_as_an_empty_group_list() {
        // FR-3: not an error, and does not affect the projects it loads alongside.
        assert!(parse_groups(b"").is_empty());
        assert!(parse_groups(b"{ not json").is_empty());
        assert!(parse_groups(br#"{"version":1}"#).is_empty());
        assert!(parse_groups(br#"{"version":1,"projects":[]}"#).is_empty());

        let good = if cfg!(windows) { "D:\\a" } else { "/a" };
        let doc = json!({
            "version": 1,
            "projects": [{ "id": "p1", "name": "keep", "root": good, "createdAt": 1, "lastUsedAt": 2 }],
        });
        assert!(parse_registry(doc.to_string().as_bytes()).len() == 1);
        assert!(parse_groups(doc.to_string().as_bytes()).is_empty());
    }

    #[test]
    fn one_undeserializable_group_entry_is_skipped_not_fatal() {
        let doc = json!({
            "version": 1,
            "groups": [
                { "id": "g1", "name": "keep", "createdAt": 1 },
                { "name": "no id at all" },
                "not even an object",
                { "id": "g2", "name": "also keep" },
            ]
        });
        let loaded = parse_groups(doc.to_string().as_bytes());
        assert_eq!(
            loaded.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec!["g1", "g2"]
        );
        // a missing createdAt degrades to 0 rather than dropping the entry
        assert_eq!(loaded[1].created_at, 0);
    }

    #[test]
    fn groups_round_trip_alongside_projects_in_one_document() {
        let dir = tmp_root("groups-roundtrip");
        let path = dir.join("projects.json");
        let projects = vec![project_fixture(
            "p1",
            "francois",
            &dir.to_string_lossy(),
            40,
        )];
        let groups = vec![
            group_fixture("g1", "ODO", 5),
            group_fixture("g2", "Other", 10),
        ];
        save_to(&path, &projects, &groups).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["groups"].as_array().unwrap().len(), 2);
        assert_eq!(load_from(&path), projects);
        assert_eq!(load_groups_from(&path), groups);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_project_meta_carries_group_id_as_an_omitted_key_when_ungrouped() {
        let dir = tmp_root("meta-group");
        let mut p = project_fixture("p1", "francois", &dir.to_string_lossy(), 40);
        let v = serde_json::to_value(meta_of(&p)).unwrap();
        assert!(
            v.get("groupId").is_none(),
            "ungrouped must OMIT groupId, never null"
        );

        p.group_id = Some("g1".into());
        let v = serde_json::to_value(meta_of(&p)).unwrap();
        assert_eq!(v["groupId"], "g1");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- project-groups FR-5: group ordering ----

    #[test]
    fn groups_list_orders_by_created_at_asc_then_name_asc_case_insensitively() {
        let groups = vec![
            group_fixture("g1", "zulu", 100),
            group_fixture("g2", "Bravo", 50),
            group_fixture("g3", "alpha", 50),
        ];
        let ordered = list_groups(&groups);
        assert_eq!(
            ordered.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec!["g3", "g2", "g1"],
            "createdAt asc, then name asc case-insensitively"
        );
    }
}

#[cfg(test)]
mod decision_tests {
    //! FR-6/FR-7 command decisions + the FR-8 comparison edges the first suite
    //! left on faith. These are what commands.rs used to inline.

    use super::*;
    use crate::project::testutil::*;

    fn defaults_with_model(id: &str) -> ProjectDefaults {
        ProjectDefaults {
            model_id: Some(id.into()),
            ..Default::default()
        }
    }

    // ---------- FR-6: create ----------

    #[test]
    fn create_rejects_a_root_another_project_already_owns() {
        let dir = tmp_root("create-dup");
        let root = normalize_root(&dir.to_string_lossy());
        let existing = vec![project_fixture("p1", "first", &root, 1)];

        // section 9: "Two projects cannot share a root"
        let err = create_entry(&existing, &root, None, None, "new".into(), 5).unwrap_err();
        assert_eq!(err, ("PROJECT_DUPLICATE_ROOT", DUPLICATE_ROOT_MSG));

        // a DIFFERENT root is fine, and names are not unique (section 7 #25)
        let other = format!("{root}{SEP}sub");
        let made = create_entry(&existing, &other, Some("first"), None, "new".into(), 5).unwrap();
        assert_eq!(made.name, "first");
        assert_eq!(made.root, other);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn create_duplicate_check_is_case_insensitive_on_windows() {
        // section 9: "on Windows the check is case-insensitive"
        let existing = vec![project_fixture("p1", "a", "D:\\Repo", 1)];
        assert_eq!(
            create_entry(&existing, "D:\\repo", None, None, "n".into(), 0).unwrap_err(),
            ("PROJECT_DUPLICATE_ROOT", DUPLICATE_ROOT_MSG)
        );
    }

    #[test]
    fn create_defaults_the_name_stamps_both_timestamps_and_keeps_defaults_verbatim() {
        let root = if cfg!(windows) {
            "D:\\code\\francois"
        } else {
            "/code/francois"
        };
        let p = create_entry(
            &[],
            root,
            None,
            Some(defaults_with_model("opus")),
            "id1".into(),
            77,
        )
        .unwrap();
        assert_eq!(p.name, "francois", "FR-6: name defaults to the basename");
        assert_eq!(p.id, "id1");
        // FR-4: both stamped on creation; only FR-20 moves last_used_at afterwards
        assert_eq!((p.created_at, p.last_used_at), (77, 77));
        assert_eq!(p.defaults.model_id.as_deref(), Some("opus"));
        // omitted defaults stay unset ("inherit"), never invented
        assert_eq!(p.defaults.effort, None);
    }

    #[test]
    fn create_rejects_a_bad_name() {
        let root = if cfg!(windows) { "D:\\a" } else { "/a" };
        assert_eq!(
            create_entry(&[], root, Some("   "), None, "i".into(), 0).unwrap_err(),
            ("INVALID_INPUT", BAD_NAME_MSG)
        );
        assert!(create_entry(&[], root, Some(&"x".repeat(81)), None, "i".into(), 0).is_err());
        assert!(create_entry(&[], root, Some(&"x".repeat(80)), None, "i".into(), 0).is_ok());
    }

    // ---------- FR-7: update ----------

    #[test]
    fn patch_touches_only_the_fields_present() {
        let root = if cfg!(windows) { "D:\\a" } else { "/a" };
        let mut p = project_fixture("p1", "old", root, 9);
        p.defaults = defaults_with_model("opus");
        let list = vec![p];

        // name only
        let (i, patched) = patch_entry(&list, "p1", Some("  new  "), None, None).unwrap();
        assert_eq!(i, 0);
        assert_eq!(patched.name, "new", "trimmed");
        assert_eq!(patched.root, list[0].root, "root untouched");
        assert_eq!(
            patched.defaults.model_id.as_deref(),
            Some("opus"),
            "defaults untouched"
        );
        // FR-4: a patch never restamps createdAt/lastUsedAt
        assert_eq!(
            (patched.created_at, patched.last_used_at),
            (list[0].created_at, 9)
        );

        // defaults REPLACE wholesale, which is how "inherit" is restored (FR-7)
        let (_, cleared) =
            patch_entry(&list, "p1", None, None, Some(ProjectDefaults::default())).unwrap();
        assert_eq!(cleared.defaults, ProjectDefaults::default());
        assert_eq!(cleared.name, "old", "name untouched");
    }

    #[test]
    fn patch_excludes_the_project_itself_from_the_duplicate_check() {
        // FR-7: re-saving a project with its OWN root must succeed.
        let root = if cfg!(windows) { "D:\\a" } else { "/a" };
        let other = if cfg!(windows) { "D:\\b" } else { "/b" };
        let list = vec![
            project_fixture("p1", "one", root, 1),
            project_fixture("p2", "two", other, 1),
        ];
        assert!(patch_entry(&list, "p1", None, Some(root), None).is_ok());
        // but taking ANOTHER project's root is still rejected
        assert_eq!(
            patch_entry(&list, "p1", None, Some(other), None).unwrap_err(),
            ("PROJECT_DUPLICATE_ROOT", DUPLICATE_ROOT_MSG)
        );
    }

    #[test]
    fn patch_reports_not_found_for_an_unknown_id() {
        assert_eq!(
            patch_entry(&[], "nope", Some("x"), None, None).unwrap_err(),
            ("PROJECT_NOT_FOUND", NOT_FOUND_MSG)
        );
    }

    // ---------- root_of: the standards target ----------

    #[test]
    fn root_of_prefers_not_found_over_root_missing() {
        let dir = tmp_root("root-of");
        let list = vec![
            project_fixture("p1", "live", &dir.to_string_lossy(), 1),
            project_fixture("p2", "gone", &missing_root("root-of"), 1),
        ];
        assert_eq!(
            root_of(&list, "p1").unwrap(),
            normalize_root(&dir.to_string_lossy())
        );
        assert_eq!(
            root_of(&list, "p2").unwrap_err(),
            ("PROJECT_ROOT_MISSING", ROOT_MISSING_MSG)
        );
        // section 7 #13: an id removed a moment earlier is NOT_FOUND, not ROOT_MISSING
        assert_eq!(
            root_of(&list, "nope").unwrap_err(),
            ("PROJECT_NOT_FOUND", NOT_FOUND_MSG)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-8 edges the first suite took on faith ----------

    #[test]
    fn two_unusable_roots_never_collide() {
        // the !ca.is_empty() guard in same_root, whose whole purpose was unexercised
        assert!(!same_root("", ""));
        assert!(!same_root("   ", ""));
    }

    #[cfg(windows)]
    #[test]
    fn different_drives_never_match_or_nest() {
        // the justification for making the root marker its own component
        assert!(!same_root("D:\\a", "C:\\a"));
        assert!(!root_components("C:\\a\\b").starts_with(&root_components("D:\\a")));
    }

    #[cfg(windows)]
    #[test]
    fn unc_roots_compare_case_insensitively_and_a_bare_share_survives() {
        assert!(same_root(
            "\\\\wsl$\\Ubuntu\\home\\u",
            "\\\\wsl$\\ubuntu\\home\\U"
        ));
        assert!(same_root("\\\\server\\share", "\\\\SERVER\\Share"));
        // A share root is a BARE root, so like `D:\` it keeps its separator. What
        // matters is that both spellings agree and the form is idempotent — not
        // which of the two spellings wins.
        let with = normalize_root("\\\\server\\share\\");
        let without = normalize_root("\\\\server\\share");
        assert_eq!(with, without);
        assert_eq!(normalize_root(&with), with, "idempotent");
        // ...and a real child still nests inside it component-wise
        assert!(root_components("\\\\server\\share\\dir").starts_with(&root_components(&with)));
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_prefix_names_the_same_directory_as_the_plain_spelling() {
        // otherwise the same folder could be registered twice (FR-6)
        assert!(same_root("\\\\?\\D:\\repo", "D:\\repo"));
        assert_eq!(normalize_root("\\\\?\\D:\\repo\\"), "D:\\repo");
        assert!(same_root("\\\\?\\UNC\\server\\share", "\\\\server\\share"));
    }

    #[test]
    fn parent_segments_cannot_escape_above_the_root() {
        // the parts.pop()-on-empty branch, documented in a comment and asserted nowhere
        let (root, deep) = if cfg!(windows) {
            ("D:\\", "D:\\a\\..\\..\\..\\b")
        } else {
            ("/", "/a/../../../b")
        };
        assert_eq!(normalize_root(deep), format!("{root}b"));
        assert!(normalize_root(&format!("{root}..")).starts_with(root));
    }

    #[test]
    fn a_prefixed_relative_path_keeps_its_prefix_leading() {
        // regression: the tail-append branch emitted ["foo", "d:"] for `D:foo`
        #[cfg(windows)]
        {
            let c = root_components("D:foo");
            assert_eq!(c.first().map(String::as_str), Some("d:"));
            assert_eq!(c.last().map(String::as_str), Some("foo"));
        }
        // a relative path is never a valid root either way
        assert!(validate_root("relative/path").is_err());
    }
    // ---------- session-profiles: clearing a deleted profile's references ----------

    // A sweep only reads one `defaults` field, so the root needs to be
    // well-formed, not to exist — no temp dirs here.
    fn with_profile(id: &str, profile: Option<&str>) -> Project {
        let root = if cfg!(windows) {
            format!("D:\\{id}")
        } else {
            format!("/tmp/{id}")
        };
        let mut p = project_fixture(id, id, &root, 0);
        p.defaults.profile_id = profile.map(str::to_string);
        p
    }

    #[test]
    fn clearing_a_profile_only_touches_the_projects_naming_it() {
        let mut projects = vec![
            with_profile("p1", Some("pr1")),
            with_profile("p2", Some("pr2")),
            with_profile("p3", Some("pr1")),
            with_profile("p4", None),
        ];
        assert_eq!(clear_profile_from(&mut projects, "pr1"), 2);
        assert_eq!(projects[0].defaults.profile_id, None);
        assert_eq!(projects[1].defaults.profile_id.as_deref(), Some("pr2"));
        assert_eq!(projects[2].defaults.profile_id, None);
        assert_eq!(projects[3].defaults.profile_id, None);
    }

    // The caller skips the disk write entirely on 0 — a profile no project used
    // must not rewrite projects.json.
    #[test]
    fn clearing_an_unreferenced_profile_reports_no_change() {
        let mut projects = vec![with_profile("p1", Some("pr2")), with_profile("p2", None)];
        assert_eq!(clear_profile_from(&mut projects, "pr1"), 0);
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr2"));
    }

    // Every OTHER default is independent of the profile and must survive the
    // sweep — clearing the profile is not clearing the project's config.
    #[test]
    fn clearing_a_profile_leaves_every_other_default_intact() {
        let mut projects = vec![with_profile("p1", Some("pr1"))];
        projects[0].defaults.model_id = Some("claude-opus-4".into());
        projects[0].defaults.effort = Some("high".into());
        projects[0].defaults.permission_mode = Some("plan".into());
        projects[0].defaults.account_id = Some("acct-2".into());

        assert_eq!(clear_profile_from(&mut projects, "pr1"), 1);
        let d = &projects[0].defaults;
        assert_eq!(d.profile_id, None);
        assert_eq!(d.model_id.as_deref(), Some("claude-opus-4"));
        assert_eq!(d.effort.as_deref(), Some("high"));
        assert_eq!(d.permission_mode.as_deref(), Some("plan"));
        assert_eq!(d.account_id.as_deref(), Some("acct-2"));
    }

    #[test]
    fn clearing_an_account_only_touches_the_projects_naming_it() {
        let mut projects = vec![
            with_profile("p1", None),
            with_profile("p2", None),
            with_profile("p3", None),
        ];
        projects[0].defaults.account_id = Some("acct-1".into());
        projects[1].defaults.account_id = Some("acct-2".into());
        projects[2].defaults.account_id = Some("acct-1".into());

        assert_eq!(clear_account_from(&mut projects, "acct-1"), 2);
        assert_eq!(projects[0].defaults.account_id, None);
        assert_eq!(projects[1].defaults.account_id.as_deref(), Some("acct-2"));
        assert_eq!(projects[2].defaults.account_id, None);
    }

    #[test]
    fn clearing_an_unreferenced_account_reports_no_change() {
        let mut projects = vec![with_profile("p1", None)];
        projects[0].defaults.account_id = Some("acct-2".into());
        assert_eq!(clear_account_from(&mut projects, "acct-1"), 0);
        assert_eq!(projects[0].defaults.account_id.as_deref(), Some("acct-2"));
    }

    // The two sweeps must not reach into each other's field: removing an account
    // leaves the project's profile default alone, and vice versa. A `field`
    // picker wired to the wrong member would pass every test above.
    #[test]
    fn the_two_sweeps_are_independent() {
        let mut projects = vec![with_profile("p1", Some("pr1"))];
        projects[0].defaults.account_id = Some("acct-1".into());

        assert_eq!(clear_account_from(&mut projects, "acct-1"), 1);
        assert_eq!(projects[0].defaults.account_id, None);
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr1"));

        assert_eq!(clear_profile_from(&mut projects, "pr1"), 1);
        assert_eq!(projects[0].defaults.profile_id, None);

        // An id that happens to collide across the two registries only clears the
        // field its own sweep owns.
        let mut shared = vec![with_profile("p2", Some("same-id"))];
        shared[0].defaults.account_id = Some("same-id".into());
        assert_eq!(clear_profile_from(&mut shared, "same-id"), 1);
        assert_eq!(shared[0].defaults.profile_id, None);
        assert_eq!(shared[0].defaults.account_id.as_deref(), Some("same-id"));
    }

    // ---------- boot-time reconcile ----------

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn reconcile_drops_only_the_ids_that_no_longer_exist() {
        let mut projects = vec![
            with_profile("p1", Some("pr-live")),
            with_profile("p2", Some("pr-gone")),
            with_profile("p3", None),
        ];
        projects[0].defaults.account_id = Some("acct-live".into());
        projects[1].defaults.account_id = Some("acct-gone".into());

        let (profiles, accounts) = (ids(&["pr-live"]), ids(&["default", "acct-live"]));
        assert_eq!(
            reconcile_defaults_in(&mut projects, Some(&profiles), Some(&accounts)),
            2
        );
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr-live"));
        assert_eq!(
            projects[0].defaults.account_id.as_deref(),
            Some("acct-live")
        );
        assert_eq!(projects[1].defaults.profile_id, None);
        assert_eq!(projects[1].defaults.account_id, None);
    }

    // THE important one. An empty/unreadable registry arrives as `None`, and must
    // clear NOTHING — the failure mode it guards against is wiping every
    // project's configuration because a JSON file momentarily failed to parse.
    #[test]
    fn reconcile_leaves_a_field_untouched_when_its_registry_is_not_trusted() {
        let mut projects = vec![with_profile("p1", Some("pr-gone"))];
        projects[0].defaults.account_id = Some("acct-gone".into());

        // Neither registry trusted: nothing is cleared, even though both ids are
        // absent from every set.
        assert_eq!(reconcile_defaults_in(&mut projects, None, None), 0);
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr-gone"));
        assert_eq!(
            projects[0].defaults.account_id.as_deref(),
            Some("acct-gone")
        );

        // One trusted, one not: only the trusted field is reconciled.
        let accounts = ids(&["default"]);
        assert_eq!(
            reconcile_defaults_in(&mut projects, None, Some(&accounts)),
            1
        );
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr-gone"));
        assert_eq!(projects[0].defaults.account_id, None);
    }

    // The caller skips the disk write on 0, so a clean registry must report 0 —
    // otherwise every launch rewrites projects.json.
    #[test]
    fn reconcile_reports_no_change_when_every_reference_resolves() {
        let mut projects = vec![
            with_profile("p1", Some("pr-live")),
            with_profile("p2", None),
        ];
        projects[0].defaults.account_id = Some("default".into());
        let (profiles, accounts) = (ids(&["pr-live"]), ids(&["default"]));
        assert_eq!(
            reconcile_defaults_in(&mut projects, Some(&profiles), Some(&accounts)),
            0
        );
        assert_eq!(projects[0].defaults.profile_id.as_deref(), Some("pr-live"));
        assert_eq!(projects[0].defaults.account_id.as_deref(), Some("default"));
    }

    // The built-in account id must survive: it is always valid and is never a
    // registered row.
    #[test]
    fn reconcile_keeps_the_builtin_default_account() {
        let mut projects = vec![with_profile("p1", None)];
        projects[0].defaults.account_id = Some("default".into());
        let accounts = ids(&["default", "acct-1"]);
        assert_eq!(
            reconcile_defaults_in(&mut projects, None, Some(&accounts)),
            0
        );
        assert_eq!(projects[0].defaults.account_id.as_deref(), Some("default"));
    }

    #[test]
    fn clearing_a_profile_round_trips_through_the_registry_file() {
        let dir = tmp_root("clear-persist");
        let path = dir.join("projects.json");
        let mut projects = vec![
            with_profile("p1", Some("pr1")),
            with_profile("p2", Some("pr2")),
        ];
        clear_profile_from(&mut projects, "pr1");
        save_to(&path, &projects, &[]).unwrap();

        let reloaded = load_from(&path);
        assert_eq!(reloaded[0].defaults.profile_id, None);
        assert_eq!(reloaded[1].defaults.profile_id.as_deref(), Some("pr2"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- project-groups: group decisions ----------

    // ---- FR-1/FR-4: create ----

    #[test]
    fn create_group_trims_and_bounds_the_name_and_is_not_unique() {
        let g = create_group_entry("  ODO  ", "g1".into(), 5).unwrap();
        assert_eq!(g.name, "ODO");
        assert_eq!(g.id, "g1");
        assert_eq!(g.created_at, 5);

        // names are NOT unique — two groups may share a name
        assert!(create_group_entry("ODO", "g2".into(), 6).is_ok());

        assert_eq!(
            create_group_entry("   ", "g3".into(), 0).unwrap_err(),
            ("INVALID_INPUT", BAD_GROUP_NAME_MSG)
        );
        assert!(create_group_entry(&"x".repeat(80), "g4".into(), 0).is_ok());
        assert!(create_group_entry(&"x".repeat(81), "g5".into(), 0).is_err());
    }

    // ---- FR-4: rename ----

    #[test]
    fn rename_group_patches_only_the_name_and_reports_not_found() {
        let groups = vec![
            group_fixture("g1", "old", 1),
            group_fixture("g2", "other", 2),
        ];
        let (idx, patched) = rename_group_entry(&groups, "g1", "  new  ").unwrap();
        assert_eq!(idx, 0);
        assert_eq!(patched.name, "new");
        assert_eq!(patched.created_at, 1, "createdAt is never restamped");

        assert_eq!(
            rename_group_entry(&groups, "g1", "   ").unwrap_err(),
            ("INVALID_INPUT", BAD_GROUP_NAME_MSG)
        );
        assert_eq!(
            rename_group_entry(&groups, "nope", "x").unwrap_err(),
            ("GROUP_NOT_FOUND", GROUP_NOT_FOUND_MSG)
        );
    }

    // ---- FR-7: assign / unassign ----

    #[test]
    fn assign_group_sets_clears_and_revalidates_against_the_live_registry() {
        let groups = vec![group_fixture("g1", "ODO", 1)];
        let projects = vec![project_fixture("p1", "frontend", "/a", 1)];

        // set
        let (idx, patched) = assign_group_entry(&projects, &groups, "p1", Some("g1")).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(patched.group_id.as_deref(), Some("g1"));

        // an unknown groupId is rejected even though the caller believed it existed
        // (2026-08-17 · security — the core re-validates, never trusts the frontend)
        assert_eq!(
            assign_group_entry(&projects, &groups, "p1", Some("ghost")).unwrap_err(),
            ("GROUP_NOT_FOUND", GROUP_NOT_FOUND_MSG)
        );

        // clear (explicit None)
        let mut grouped = projects.clone();
        grouped[0].group_id = Some("g1".into());
        let (_, cleared) = assign_group_entry(&grouped, &groups, "p1", None).unwrap();
        assert_eq!(cleared.group_id, None);

        // unknown project
        assert_eq!(
            assign_group_entry(&projects, &groups, "nope", Some("g1")).unwrap_err(),
            ("PROJECT_NOT_FOUND", NOT_FOUND_MSG)
        );
    }

    // ---- FR-8: the delete sweep ----

    #[test]
    fn clearing_a_group_only_touches_the_projects_naming_it() {
        let mut projects = vec![
            project_fixture("p1", "a", "/a", 1),
            project_fixture("p2", "b", "/b", 1),
            project_fixture("p3", "c", "/c", 1),
        ];
        projects[0].group_id = Some("g1".into());
        projects[1].group_id = Some("g2".into());
        projects[2].group_id = Some("g1".into());

        assert_eq!(clear_group_from(&mut projects, "g1"), 2);
        assert_eq!(projects[0].group_id, None);
        assert_eq!(projects[1].group_id.as_deref(), Some("g2"));
        assert_eq!(projects[2].group_id, None);
    }

    #[test]
    fn clearing_an_unreferenced_group_reports_no_change() {
        let mut projects = vec![project_fixture("p1", "a", "/a", 1)];
        projects[0].group_id = Some("g2".into());
        assert_eq!(clear_group_from(&mut projects, "g1"), 0);
        assert_eq!(projects[0].group_id.as_deref(), Some("g2"));
    }

    #[test]
    fn clearing_a_group_leaves_every_other_field_intact() {
        let mut projects = vec![project_fixture("p1", "a", "/a", 1)];
        projects[0].group_id = Some("g1".into());
        projects[0].defaults.model_id = Some("opus".into());

        assert_eq!(clear_group_from(&mut projects, "g1"), 1);
        assert_eq!(projects[0].group_id, None);
        assert_eq!(projects[0].defaults.model_id.as_deref(), Some("opus"));
    }

    // ---- FR-10 (mirrored for groups): commit_with rolls back on a real,
    // failing persist ----

    #[test]
    fn commit_with_rolls_back_groups_on_a_persist_failure() {
        // project-groups FR-10, HIGH remediation: the exact rollback shape
        // `commit_groups`/`persist` use in commands.rs, exercised here with a
        // REAL failing write (an unwritable directory) rather than a mock, and
        // asserted to restore the pre-mutation `groups` slot — not just report
        // an error.
        let mut slot = vec![group_fixture("g1", "Alpha", 1)];
        let snapshot = slot.clone();
        let next = vec![
            group_fixture("g1", "Alpha", 1),
            group_fixture("g2", "Beta", 2),
        ];
        // A REAL, unwritable target: `save_to` mkdir -p's a missing PARENT, so a
        // bare missing directory would not fail — but a path component that is
        // itself a plain FILE can never become a directory, which is exactly the
        // failure `create_dir_all` (and thus `persist`) reports for a genuinely
        // broken app data directory.
        let blocker = tmp_root("commit-with-rollback").join("blocker-file");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let unwritable_file = blocker.join("sub").join("projects.json");

        let result = commit_with(&mut slot, next, |groups| {
            save_to(&unwritable_file, &[], groups)
        });

        assert!(result.is_err());
        assert_eq!(slot, snapshot);
    }
}

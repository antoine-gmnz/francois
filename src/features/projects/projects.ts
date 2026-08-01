// projects — feature-local pure logic (spec §6). The four containment/ordering
// helpers of §5 (isPathInside, resolveProjectForCwd, orderProjects,
// filterSessionsByProject) live in contract/projects.ts and are imported from
// there by the components — never reimplemented here.
//
// This module owns what the contract does not: the localStorage read/write for
// activeProjectId (FR-26), the default-application of FR-21/FR-22, the modal's
// derived copy (standards footer, counts, confirmations) and the small pure
// list edits the standards editor commits.

import type {
  AppError,
  ClaudeRuntime,
  ModelInfo,
  PermissionMode,
  ProjectDefaults,
  ProjectId,
  Result,
  SessionMeta,
} from '../../../contract/common';
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  MAX_RULES,
  MAX_RULE_LENGTH,
  filterSessionsByProject,
  type ProjectMeta,
} from '../../../contract/projects';
import { displayWslCwd } from '../../../contract/wsl-filesystem';

// ---------- activeProjectId persistence (FR-26) ----------

/**
 * The restored "All projects | <id>" selection. Guarded exactly like the store's
 * other localStorage reads: a restricted storage environment (or the node test
 * env, which has no localStorage at all) degrades to null = All.
 */
export function loadActiveProjectId(): ProjectId | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/** null (All projects) removes the key rather than storing a sentinel. */
export function persistActiveProjectId(id: ProjectId | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * FR-26 / §7 case 16: an id that is not in the fetched list falls back to All —
 * on launch (a restored id naming a removed project) and live (the active
 * project removed from the modal).
 */
export function reconcileActiveProjectId(
  current: ProjectId | null,
  projects: ProjectMeta[],
): ProjectId | null {
  if (current === null) return null;
  return projects.some((p) => p.id === current) ? current : null;
}

// ---------- new-session defaults (FR-21/FR-22) ----------

/** The five new-session fields a project can pre-fill. */
export interface SessionFormValues {
  modelId: string;
  /** '' = the model's own default effort. */
  effort: string;
  permissionMode: PermissionMode;
  runtime: ClaudeRuntime;
  allowGit: boolean;
}

/** What the modal can actually honor right now: the live catalog + this OS. */
export interface DefaultsEnv {
  models: ModelInfo[];
  /** false off Windows — 'wsl' is not offered there (§7 case 24). */
  allowWsl: boolean;
}

/** The pre-feature defaults — what "— none —" resets the form to (FR-22). */
export function baseFormValues(models: ModelInfo[]): SessionFormValues {
  return {
    modelId: models[0]?.id ?? '',
    effort: '',
    permissionMode: 'default',
    runtime: 'native',
    allowGit: false,
  };
}

export interface AppliedDefaults {
  values: SessionFormValues;
  /**
   * The project's default modelId when it is no longer in the catalog — the
   * picker fell back to its own default and the modal shows this id dim
   * (§7 case 22). null when the default resolved (or was unset).
   */
  staleModelId: string | null;
}

/**
 * FR-21/FR-22: every default the project declares overwrites the corresponding
 * field; fields it leaves unset keep the pre-feature default. `defaults` null or
 * undefined ⇒ a plain reset to `base` (the "— none —" case).
 *
 * Three edge cases are honored here rather than at render time, so what the user
 * sees is exactly what session_create receives: an unknown model falls back
 * (case 22), an effort the resolved model does not advertise is dropped
 * (case 23), and 'wsl' off Windows falls back to native (case 24).
 */
export function applyProjectDefaults(
  base: SessionFormValues,
  defaults: ProjectDefaults | null | undefined,
  env: DefaultsEnv,
): AppliedDefaults {
  const values: SessionFormValues = { ...base };
  if (!defaults) return { values, staleModelId: null };

  let staleModelId: string | null = null;
  if (defaults.modelId !== undefined) {
    if (env.models.some((m) => m.id === defaults.modelId)) values.modelId = defaults.modelId;
    else staleModelId = defaults.modelId;
  }
  if (defaults.permissionMode !== undefined) values.permissionMode = defaults.permissionMode;
  if (defaults.runtime !== undefined) {
    values.runtime = defaults.runtime === 'wsl' && !env.allowWsl ? 'native' : defaults.runtime;
  }
  if (defaults.allowGit !== undefined) values.allowGit = defaults.allowGit;
  if (defaults.effort !== undefined) {
    const efforts = env.models.find((m) => m.id === values.modelId)?.efforts ?? [];
    values.effort = efforts.includes(defaults.effort) ? defaults.effort : '';
  }
  return { values, staleModelId };
}

// ---------- switcher (FR-25/FR-29) ----------

export const ALL_PROJECTS_LABEL = 'All projects';

export function switcherLabel(project: ProjectMeta | null): string {
  return project ? project.name : ALL_PROJECTS_LABEL;
}

export interface SwitcherRow {
  /** null = the "All projects" row. */
  id: ProjectId | null;
  name: string;
  /** '' for the All row. */
  root: string;
  missing: boolean;
  selected: boolean;
  /** '✦' on the selected row, '' otherwise (§8 B). */
  mark: string;
}

/** FR-25: All projects, then the list in the order the core returned (FR-5). */
export function buildSwitcherRows(
  projects: ProjectMeta[],
  activeProjectId: ProjectId | null,
): SwitcherRow[] {
  const all: SwitcherRow = {
    id: null,
    name: ALL_PROJECTS_LABEL,
    root: '',
    missing: false,
    selected: activeProjectId === null,
    mark: activeProjectId === null ? '✦' : '',
  };
  return [
    all,
    ...projects.map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      missing: !p.rootExists,
      selected: p.id === activeProjectId,
      mark: p.id === activeProjectId ? '✦' : '',
    })),
  ];
}

/** FR-5 (titlebar-project-switcher) — which tone the title-bar dot wears. */
export type SwitcherDotTone = 'ok' | 'missing' | 'none';

export function switcherDotTone(project: ProjectMeta | null): SwitcherDotTone {
  if (!project) return 'none';
  return project.rootExists ? 'ok' : 'missing';
}

/**
 * FR-6 (titlebar-project-switcher) — the switcher button's `title`: the scoped
 * project's root, else the active session's cwd, else `home`. A WSL cwd
 * renders in its own compact form (`displayWslCwd`) rather than the raw UNC path.
 */
export function switcherTooltip(project: ProjectMeta | null, sessionCwd: string | null, home: string): string {
  const raw = project?.root ?? sessionCwd ?? home;
  return displayWslCwd(raw) ?? raw;
}

/** FR-29: the filtered-empty board state names the project. */
export function filteredEmptyLabel(project: ProjectMeta | null): string {
  return project ? `no sessions in ${project.name}` : 'no sessions';
}

// ---------- modal copy (FR-33/FR-34/FR-36) ----------

export function projectCountLabel(n: number): string {
  return `${n} project${n === 1 ? '' : 's'}`;
}

/** FR-34.3 footer: '→ <root>\CLAUDE.md · francois block', in the root's own separator. */
export function standardsFooterPath(root: string): string {
  if (root === '') return '→ CLAUDE.md · francois block';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `→ ${trimmed}${sep}CLAUDE.md · francois block`;
}

/** §7 case 9 — the documented cost of the managed block, stated in the footer. */
export const STANDARDS_FOOTER_NOTE = 'content inside the markers is managed by francois';

/** FR-38: the single explanatory line under Identity for a missing root. */
export const ROOT_MISSING_LINE = 'root missing — fix the path to edit this project';

/** FR-23: the new-session modal's block on a project whose root is gone. */
export const PROJECT_ROOT_MISSING_LINE = 'project root is missing';

export function removeConfirmText(name: string): string {
  return `remove project "${name}"? sessions are kept; CLAUDE.md is not touched`;
}

/** Abbreviated root for the switcher dropdown and the modal's left list (§8 B/C). */
export function abbreviateRoot(root: string, home: string): string {
  if (home && (root === home || root.startsWith(home + '/') || root.startsWith(home + '\\'))) {
    return '~' + root.slice(home.length);
  }
  return root;
}

/** FR-36: after a removal, select the next row — or the previous one at the end. */
export function nextSelectionAfterRemove(
  projects: ProjectMeta[],
  removedId: ProjectId,
): ProjectId | null {
  const rest = projects.filter((p) => p.id !== removedId);
  if (rest.length === 0) return null;
  const idx = projects.findIndex((p) => p.id === removedId);
  if (idx < 0) return rest[0].id;
  return rest[Math.min(idx, rest.length - 1)].id;
}

// ---------- the defaults form (FR-34.2) ----------

export type DefaultsKey = keyof ProjectDefaults;

export interface FieldOption {
  value: string;
  label: string;
}

export interface DefaultFieldDef {
  key: DefaultsKey;
  label: string;
  /** Always opens with { value: '', label: 'inherit' }. */
  options: FieldOption[];
}

/** Canonical effort ladder — the order the CLI advertises them in. */
const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The efforts offered for a project's default model. An unset (or unknown) model
 * means the project inherits the modal's model, so every effort any catalog model
 * advertises is offered, in ladder order.
 */
export function effortOptions(models: ModelInfo[], modelId: string): string[] {
  // Match on the MODEL, not on its `efforts`: ModelInfo.efforts is optional, so a
  // known model that simply advertises none was falling through to the union branch
  // and being offered every effort in the catalog — the "no model selected" answer.
  const own = models.find((m) => m.id === modelId);
  if (own) return (own.efforts ?? []).slice();
  const union = new Set<string>();
  for (const m of models) for (const e of m.efforts ?? []) union.add(e);
  return EFFORT_LADDER.filter((e) => union.has(e));
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const RUNTIMES: ClaudeRuntime[] = ['native', 'wsl'];

const INHERIT: FieldOption = { value: '', label: 'inherit' };

/**
 * The slice of `Account` (contract/multi-account.ts) the defaults form needs.
 * Structural on purpose: this module stays free of the multi-account feature so
 * the dependency runs one way only (sessions/accounts import projects, not the
 * reverse).
 */
export interface AccountOptionSource {
  id: string;
  label: string;
}

/**
 * FR-34.2: uniform selects, every one carrying `inherit` first (which is how
 * a default is cleared — FR-7 replaces the whole defaults object).
 * `allow git` is a select, not a toggle, precisely because it has three states.
 *
 * multi-account FR-20 adds a sixth, `account`, but ONLY once a second account
 * exists: with a single account the control would offer one real choice, and
 * omitting it keeps the pre-multi-account form byte-identical.
 */
export function defaultFieldDefs(
  models: ModelInfo[],
  defaults: ProjectDefaults,
  allowWsl: boolean,
  accounts: AccountOptionSource[] = [],
): DefaultFieldDef[] {
  const accountField: DefaultFieldDef[] =
    accounts.length > 1
      ? [
          {
            key: 'accountId',
            label: 'account',
            options: [INHERIT, ...accounts.map((a) => ({ value: a.id, label: a.label }))],
          },
        ]
      : [];
  return [
    ...accountField,
    {
      key: 'modelId',
      label: 'model',
      options: [INHERIT, ...models.map((m) => ({ value: m.id, label: m.label }))],
    },
    {
      key: 'effort',
      label: 'effort',
      options: [INHERIT, ...effortOptions(models, defaults.modelId ?? '').map((e) => ({ value: e, label: e }))],
    },
    {
      key: 'permissionMode',
      label: 'permission mode',
      options: [INHERIT, ...PERMISSION_MODES.map((m) => ({ value: m, label: m }))],
    },
    {
      key: 'runtime',
      label: 'runtime',
      // wsl is Windows-only (§7 case 24) — the same gate NewSessionModal applies.
      options: [
        INHERIT,
        ...RUNTIMES.filter((r) => r !== 'wsl' || allowWsl).map((r) => ({ value: r, label: r })),
      ],
    },
    {
      key: 'allowGit',
      label: 'allow git',
      options: [INHERIT, { value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
    },
  ];
}

/** The select's current value; '' ⇒ inherit (rendered dim, §8 C). */
export function defaultsSelectValue(defaults: ProjectDefaults, key: DefaultsKey): string {
  if (key === 'allowGit') {
    return defaults.allowGit === undefined ? '' : defaults.allowGit ? 'yes' : 'no';
  }
  const v = defaults[key];
  return v === undefined ? '' : String(v);
}

/**
 * FR-7: `defaults` is replaced wholesale on every update, so a cleared field is
 * expressed by OMITTING it. This returns the next whole object for one edit.
 */
export function patchDefaults(
  defaults: ProjectDefaults,
  key: DefaultsKey,
  value: string,
): ProjectDefaults {
  const next: ProjectDefaults = { ...defaults };
  if (value === '') {
    delete next[key];
    return next;
  }
  switch (key) {
    case 'modelId':
      next.modelId = value;
      break;
    case 'effort':
      next.effort = value;
      break;
    case 'permissionMode':
      next.permissionMode = value as PermissionMode;
      break;
    case 'runtime':
      next.runtime = value as ClaudeRuntime;
      break;
    case 'allowGit':
      next.allowGit = value === 'yes';
      break;
    // multi-account FR-20: the account a new session under this project opens on.
    case 'accountId':
      next.accountId = value;
      break;
  }
  return next;
}

// ---------- standards rules (FR-34.3/FR-35) ----------

/**
 * §7 case 11: the add-rule input strips newlines on paste, so a multiline rule is
 * only reachable by a non-UI caller. Also trims and caps at the contract bound —
 * the core validates again before any I/O (FR-13).
 */
export function sanitizeRuleText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_RULE_LENGTH);
}

/** Appends a rule. An empty (or over-quota) input is a no-op. */
export function addRule(rules: string[], text: string): string[] {
  const t = sanitizeRuleText(text);
  if (t === '' || rules.length >= MAX_RULES) return rules;
  return [...rules, t];
}

/** ↑ / ↓ reorder (FR-34.3); clamped at both ends. */
export function moveRule(rules: string[], index: number, dir: -1 | 1): string[] {
  const target = index + dir;
  if (index < 0 || index >= rules.length || target < 0 || target >= rules.length) return rules;
  const next = rules.slice();
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row);
  return next;
}

export function dropRule(rules: string[], index: number): string[] {
  if (index < 0 || index >= rules.length) return rules;
  return rules.filter((_, i) => i !== index);
}

/** Inline edit commit. Emptying a row leaves it untouched (delete is the × control). */
export function replaceRule(rules: string[], index: number, text: string): string[] {
  if (index < 0 || index >= rules.length) return rules;
  const t = sanitizeRuleText(text);
  if (t === '') return rules;
  const next = rules.slice();
  next[index] = t;
  return next;
}

// ---------- new-session project field (FR-22/§8 D) ----------

export interface ProjectOption {
  value: string;
  label: string;
  /** rootExists === false — rendered dim; selectable, then blocked by FR-23. */
  missing: boolean;
}

export const NO_PROJECT_LABEL = '— none —';

export function newSessionProjectOptions(projects: ProjectMeta[]): ProjectOption[] {
  return [
    { value: '', label: NO_PROJECT_LABEL, missing: false },
    ...projects.map((p) => ({ value: p.id, label: p.name, missing: !p.rootExists })),
  ];
}

// ---------- modal section errors (FR-33/FR-34/FR-36, §6c) ----------

/** The four groups of ProjectsModal that show an inline error independently. */
export type ProjectSection = 'list' | 'identity' | 'defaults' | 'standards';

/** The all-clear state for the collapsed `Record<ProjectSection, string | null>`. */
export const EMPTY_SECTION_ERRORS: Record<ProjectSection, string | null> = {
  list: null,
  identity: null,
  defaults: null,
  standards: null,
};

// ---------- IPC guard (FR-35) ----------

/**
 * FR-35: "the modal never throws". Every project command resolves a Result for
 * domain failures, but the Tauri bridge itself can still reject (no such command,
 * serialization). This funnels that into the same inline-error path.
 */
export async function safeCall<T>(p: Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await p;
  } catch (e) {
    const error: AppError = {
      code: 'INTERNAL',
      message: e instanceof Error ? e.message : String(e),
    };
    return { ok: false, error };
  }
}

// ---------- FR-27: the board's visible set (project scope AND the '/' query) ----------

/**
 * The sessions pane [1] should render, and the number its header shows.
 *
 * Extracted from Sidebar so the AND-composition is testable: the project scope is
 * applied FIRST, then the '/' name/path query, and the header count is the size of
 * the result — not of either filter alone.
 *
 * `sidebarFilter` null or '' means no query. Matching is case-insensitive over the
 * session name and its cwd, exactly as the sidebar has always done.
 */
export function visibleSessions(
  sessions: SessionMeta[],
  activeProjectId: ProjectId | null,
  sidebarFilter: string | null,
): SessionMeta[] {
  const inProject = filterSessionsByProject(sessions, activeProjectId);
  if (sidebarFilter === null || sidebarFilter === '') return inProject;
  const q = sidebarFilter.toLowerCase();
  return inProject.filter((s) => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
}

// ---------- FR-34: the Identity commit guard ----------

/**
 * Whether an Identity edit (name / root) may be written.
 *
 * The drafts are free-text state that lives alongside the selection, so they can
 * belong to a DIFFERENT project than the one currently selected — a list-row click
 * moves `selectedId` while a focused input still holds the previous project's text,
 * and the ensuing blur would otherwise write one project's identity onto another.
 * The modal reseeds on every selection change, but this is the load-bearing guard:
 * it refuses the write outright when the draft's owner is not the current selection,
 * so any future path that forgets to reseed fails closed rather than corrupting.
 *
 * `current` is the stored value; an edit equal to it is a no-op and not worth a
 * round-trip (a blur with no change fires on every focus traversal).
 */
export function canCommitIdentity(
  draftOwner: ProjectId | null,
  selectedId: ProjectId | null,
  draft: string,
  current: string | undefined,
): boolean {
  if (selectedId === null || current === undefined) return false;
  if (draftOwner !== selectedId) return false; // the draft belongs to another project
  return draft.trim() !== '' && draft.trim() !== current;
}

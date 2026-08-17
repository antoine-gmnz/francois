// projects — unit tests over every pure helper this feature owns, plus the four
// contract helpers as this feature uses them (spec §6 "projects.test.ts").
// Node env, no DOM: localStorage is stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, SessionMeta } from '../../../contract/common';
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  MAX_RULES,
  MAX_RULE_LENGTH,
  filterSessionsByProject,
  isPathInside,
  orderProjects,
  resolveProjectForCwd,
  type ProjectMeta,
} from '../../../contract/projects';
import {
  EMPTY_SECTION_ERRORS,
  STANDARDS_FOOTER_NOTE,
  abbreviateRoot,
  addRule,
  applyProjectDefaults,
  canCommitIdentity,
  baseFormValues,
  buildSwitcherRows,
  defaultFieldDefs,
  defaultsSelectValue,
  dropRule,
  effortOptions,
  filteredEmptyLabel,
  firstSessionInProject,
  loadActiveProjectId,
  moveRule,
  newSessionProjectOptions,
  nextSelectionAfterRemove,
  patchDefaults,
  persistActiveProjectId,
  projectCountLabel,
  reconcileActiveProjectId,
  removeConfirmText,
  replaceRule,
  safeCall,
  sanitizeRuleText,
  standardsFooterPath,
  switcherDotTone,
  switcherLabel,
  switcherTooltip,
  visibleSessions,
} from './projects';

// ---------- fixtures ----------

function proj(over: Partial<ProjectMeta> & { id: string; name: string; root: string }): ProjectMeta {
  return { defaults: {}, createdAt: 0, lastUsedAt: 0, rootExists: true, ...over };
}

function sess(id: string, projectId?: string): SessionMeta {
  return {
    id,
    name: id,
    cwd: 'D:/x',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    ...(projectId ? { projectId } : {}),
  };
}

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-5', label: 'Opus 5', efforts: ['medium', 'high', 'xhigh'] },
];

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

// ---------- contract helpers, as this feature uses them ----------

describe('contract: isPathInside (FR-8 containment)', () => {
  it('matches an equal root and a true ancestor, component-wise', () => {
    expect(isPathInside('D:/francois', 'D:/francois', true)).toBe(true);
    expect(isPathInside('D:/francois/src-tauri', 'D:/francois', true)).toBe(true);
    // 'D:\a\bc' is NOT inside 'D:\a\b' (§9 acceptance)
    expect(isPathInside('D:\\a\\bc', 'D:\\a\\b', true)).toBe(false);
  });

  it('is case-insensitive only when asked (Windows vs POSIX)', () => {
    expect(isPathInside('D:\\Repo\\src', 'd:\\repo', true)).toBe(true);
    expect(isPathInside('/home/U/repo/src', '/home/u/repo', false)).toBe(false);
  });

  it('never matches an empty cwd or root', () => {
    expect(isPathInside('', 'D:/a', true)).toBe(false);
    expect(isPathInside('D:/a', '', true)).toBe(false);
  });
});

describe('contract: resolveProjectForCwd (FR-21 auto-adopt)', () => {
  const deep = proj({ id: 'p2', name: 'api', root: 'D:/repo/packages/api' });
  const shallow = proj({ id: 'p1', name: 'repo', root: 'D:/repo' });
  const gone = proj({ id: 'p3', name: 'gone', root: 'D:/repo/packages/api/sub', rootExists: false });

  it('picks the deepest matching root (§7 case 20)', () => {
    expect(resolveProjectForCwd('D:/repo/packages/api/src', [shallow, deep], true)?.id).toBe('p2');
  });

  it('excludes projects whose root is missing', () => {
    expect(resolveProjectForCwd('D:/repo/packages/api/sub/x', [shallow, deep, gone], true)?.id).toBe('p2');
  });

  it('returns null when nothing contains the cwd', () => {
    expect(resolveProjectForCwd('D:/elsewhere', [shallow, deep], true)).toBeNull();
  });
});

describe('contract: orderProjects (FR-5)', () => {
  it('orders by lastUsedAt desc, then name asc (case-insensitive)', () => {
    const list = [
      proj({ id: 'a', name: 'zeta', root: '/z', lastUsedAt: 10 }),
      proj({ id: 'b', name: 'Beta', root: '/b', lastUsedAt: 30 }),
      proj({ id: 'c', name: 'alpha', root: '/a', lastUsedAt: 30 }),
    ];
    expect(orderProjects(list).map((p) => p.id)).toEqual(['c', 'b', 'a']);
    // pure: the input is untouched
    expect(list.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('contract: filterSessionsByProject (FR-27)', () => {
  const sessions = [sess('s1', 'p1'), sess('s2'), sess('s3', 'p2')];

  it('returns every session unchanged when no project is active (FR-18)', () => {
    expect(filterSessionsByProject(sessions, null)).toBe(sessions);
  });

  it('keeps only the sessions of the active project', () => {
    expect(filterSessionsByProject(sessions, 'p1').map((s) => s.id)).toEqual(['s1']);
    // an unlinked session is never claimed by a project filter
    expect(filterSessionsByProject(sessions, 'p2').map((s) => s.id)).toEqual(['s3']);
  });
});

// ---------- activeProjectId persistence (FR-26) ----------

describe('activeProjectId persistence (FR-26)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads null when there is no storage at all', () => {
    expect(loadActiveProjectId()).toBeNull();
  });

  it('round-trips through localStorage under the contract key', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    persistActiveProjectId('p1');
    expect(store.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBe('p1');
    expect(loadActiveProjectId()).toBe('p1');
  });

  it('removes the key for null (All projects) instead of storing a sentinel', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    persistActiveProjectId('p1');
    persistActiveProjectId(null);
    expect(store.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBeNull();
    expect(loadActiveProjectId()).toBeNull();
  });

  it('treats an empty stored value as null', () => {
    const store = fakeStorage();
    store.setItem(ACTIVE_PROJECT_STORAGE_KEY, '');
    vi.stubGlobal('localStorage', store);
    expect(loadActiveProjectId()).toBeNull();
  });

  it('falls back to All when the stored id is not in the list (§7 case 16)', () => {
    const list = [proj({ id: 'p1', name: 'a', root: '/a' })];
    expect(reconcileActiveProjectId('p1', list)).toBe('p1');
    expect(reconcileActiveProjectId('gone', list)).toBeNull();
    expect(reconcileActiveProjectId('p1', [])).toBeNull();
    expect(reconcileActiveProjectId(null, list)).toBeNull();
  });
});

// ---------- new-session defaults (FR-21/FR-22) ----------

describe('applyProjectDefaults (FR-21/FR-22)', () => {
  const base = baseFormValues(MODELS);
  const env = { models: MODELS, allowWsl: true };

  it('derives the pre-feature defaults from the model catalog', () => {
    expect(base).toEqual({
      modelId: 'claude-sonnet-5',
      effort: '',
      permissionMode: 'default',
      runtime: 'native',
      allowGit: false,
    });
    expect(baseFormValues([]).modelId).toBe('');
  });

  it('resets to the pre-feature defaults for "— none —" (FR-22)', () => {
    const r = applyProjectDefaults(base, null, env);
    expect(r.values).toEqual(base);
    expect(r.staleModelId).toBeNull();
  });

  it('overwrites every field the project declares', () => {
    const r = applyProjectDefaults(base, {
      modelId: 'claude-opus-5',
      effort: 'xhigh',
      permissionMode: 'acceptEdits',
      runtime: 'wsl',
      allowGit: true,
    }, env);
    expect(r.values).toEqual({
      modelId: 'claude-opus-5',
      effort: 'xhigh',
      permissionMode: 'acceptEdits',
      runtime: 'wsl',
      allowGit: true,
    });
  });

  it('keeps the pre-feature default for every field the project leaves unset', () => {
    const r = applyProjectDefaults(base, { effort: 'high' }, env);
    expect(r.values).toEqual({ ...base, effort: 'high' });
  });

  it('falls back to its own default model and reports a stale id (§7 case 22)', () => {
    const r = applyProjectDefaults(base, { modelId: 'claude-ghost-1' }, env);
    expect(r.values.modelId).toBe('claude-sonnet-5');
    expect(r.staleModelId).toBe('claude-ghost-1');
  });

  it('drops an effort the chosen model does not advertise (§7 case 23)', () => {
    const r = applyProjectDefaults(base, { modelId: 'claude-opus-5', effort: 'low' }, env);
    expect(r.values.modelId).toBe('claude-opus-5');
    expect(r.values.effort).toBe('');
  });

  it('falls back to native when wsl is unavailable (§7 case 24)', () => {
    const r = applyProjectDefaults(base, { runtime: 'wsl' }, { models: MODELS, allowWsl: false });
    expect(r.values.runtime).toBe('native');
  });

  it('never mutates the base values it is given (FR-24 hygiene)', () => {
    const snapshot = { ...base };
    applyProjectDefaults(base, { effort: 'high', allowGit: true }, env);
    expect(base).toEqual(snapshot);
  });
});

// ---------- switcher (FR-25/FR-29) ----------

describe('switcher labels & rows (FR-25/FR-29)', () => {
  const list = [
    proj({ id: 'p1', name: 'francois', root: 'D:/francois' }),
    proj({ id: 'p2', name: 'infra', root: 'D:/ops/infra', rootExists: false }),
  ];

  it('reads "All projects" unfiltered and the project name otherwise', () => {
    expect(switcherLabel(null)).toBe('All projects');
    expect(switcherLabel(list[0])).toBe('francois');
  });

  it('builds All + one row per project, marking the selected one', () => {
    const rows = buildSwitcherRows(list, 'p1');
    expect(rows.map((r) => r.id)).toEqual([null, 'p1', 'p2']);
    expect(rows[0]).toMatchObject({ name: 'All projects', root: '', missing: false, selected: false });
    expect(rows[1]).toMatchObject({ name: 'francois', root: 'D:/francois', selected: true, mark: '✦' });
    expect(rows[2]).toMatchObject({ missing: true, selected: false, mark: '' });
  });

  it('marks the All row when nothing is filtered', () => {
    expect(buildSwitcherRows(list, null)[0]).toMatchObject({ selected: true, mark: '✦' });
  });
});

describe('switcherDotTone (FR-5 — titlebar-project-switcher)', () => {
  const list: ProjectMeta[] = [
    proj({ id: 'p1', name: 'francois', root: 'D:/francois' }),
    proj({ id: 'p2', name: 'infra', root: 'D:/ops/infra', rootExists: false }),
  ];

  it('is "ok" for a scoped project whose root exists', () => {
    expect(switcherDotTone(list[0])).toBe('ok');
  });

  it('is "missing" for a scoped project whose root is gone', () => {
    expect(switcherDotTone(list[1])).toBe('missing');
  });

  it('is "none" when unscoped (All projects)', () => {
    expect(switcherDotTone(null)).toBe('none');
  });
});

describe('switcherTooltip (FR-6 — titlebar-project-switcher)', () => {
  const project: ProjectMeta = proj({ id: 'p1', name: 'francois', root: 'D:/francois' });

  it('prefers the scoped project\'s root', () => {
    expect(switcherTooltip(project, 'D:/other/session', 'D:/home')).toBe('D:/francois');
  });

  it('falls back to the active session cwd when unscoped', () => {
    expect(switcherTooltip(null, 'D:/session/cwd', 'D:/home')).toBe('D:/session/cwd');
  });

  it('falls back to home when unscoped and no active session', () => {
    expect(switcherTooltip(null, null, 'D:/home')).toBe('D:/home');
  });

  it('renders a WSL cwd in its compact distro:path form', () => {
    expect(switcherTooltip(null, '\\\\wsl$\\Ubuntu\\home\\u\\api', 'D:/home')).toBe('Ubuntu:/home/u/api');
  });
});

describe('filteredEmptyLabel (FR-29)', () => {
  const list: ProjectMeta[] = [proj({ id: 'p1', name: 'francois', root: 'D:/francois' })];

  it('names the project in the filtered-empty board state (FR-29)', () => {
    expect(filteredEmptyLabel(list[0])).toBe('no sessions in francois');
    expect(filteredEmptyLabel(null)).toBe('no sessions');
  });
});

// ---------- modal chrome copy (FR-33/FR-34/FR-36) ----------

describe('modal copy', () => {
  it('counts the projects in the header', () => {
    expect(projectCountLabel(0)).toBe('0 projects');
    expect(projectCountLabel(4)).toBe('4 projects');
  });

  it('renders the standards footer against the root, with its own separator', () => {
    expect(standardsFooterPath('D:\\francois')).toBe('→ D:\\francois\\CLAUDE.md · francois block');
    expect(standardsFooterPath('/home/u/repo')).toBe('→ /home/u/repo/CLAUDE.md · francois block');
    expect(standardsFooterPath('')).toBe('→ CLAUDE.md · francois block');
    expect(STANDARDS_FOOTER_NOTE).toBe('content inside the markers is managed by francois');
  });

  it('spells the remove confirmation exactly (FR-36)', () => {
    expect(removeConfirmText('francois')).toBe(
      'remove project "francois"? sessions are kept; CLAUDE.md is not touched',
    );
  });

  it('abbreviates a root under the home directory', () => {
    expect(abbreviateRoot('D:/u/dev/api', 'D:/u')).toBe('~/dev/api');
    expect(abbreviateRoot('D:/other', 'D:/u')).toBe('D:/other');
    expect(abbreviateRoot('D:/u', '')).toBe('D:/u');
  });

  it('selects the next row after a removal, or none (FR-36)', () => {
    const list = [
      proj({ id: 'p1', name: 'a', root: '/a' }),
      proj({ id: 'p2', name: 'b', root: '/b' }),
      proj({ id: 'p3', name: 'c', root: '/c' }),
    ];
    expect(nextSelectionAfterRemove(list, 'p2')).toBe('p3');
    expect(nextSelectionAfterRemove(list, 'p3')).toBe('p2'); // last row → the one before it
    expect(nextSelectionAfterRemove([list[0]], 'p1')).toBeNull();
    expect(nextSelectionAfterRemove(list, 'unknown')).toBe('p1');
  });
});

// ---------- session defaults form (FR-34.2) ----------

describe('project defaults form (FR-34)', () => {
  it('opens every select with an "inherit" option', () => {
    const defs = defaultFieldDefs(MODELS, {}, true);
    expect(defs.map((d) => d.key)).toEqual(['modelId', 'effort', 'permissionMode', 'runtime', 'allowGit']);
    for (const d of defs) expect(d.options[0]).toEqual({ value: '', label: 'inherit' });
    expect(defs[4].options.map((o) => o.value)).toEqual(['', 'yes', 'no']);
  });

  it('offers wsl as a runtime only when allowWsl is true (§7 case 24)', () => {
    const runtimeOptions = (allowWsl: boolean) =>
      defaultFieldDefs(MODELS, {}, allowWsl)
        .find((d) => d.key === 'runtime')!
        .options.map((o) => o.value);
    expect(runtimeOptions(true)).toEqual(['', 'native', 'wsl']);
    expect(runtimeOptions(false)).toEqual(['', 'native']);
  });

  it('offers the efforts of the project default model, else every known effort', () => {
    expect(effortOptions(MODELS, 'claude-opus-5')).toEqual(['medium', 'high', 'xhigh']);
    expect(effortOptions(MODELS, '')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortOptions(MODELS, 'claude-ghost-1')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('renders an unset default as "" (inherit) and a set one verbatim', () => {
    expect(defaultsSelectValue({}, 'modelId')).toBe('');
    expect(defaultsSelectValue({}, 'allowGit')).toBe('');
    expect(defaultsSelectValue({ allowGit: true }, 'allowGit')).toBe('yes');
    expect(defaultsSelectValue({ allowGit: false }, 'allowGit')).toBe('no');
    expect(defaultsSelectValue({ permissionMode: 'plan' }, 'permissionMode')).toBe('plan');
  });

  it('patches ONE field and drops it entirely for inherit (FR-7 whole-object replace)', () => {
    const d = { modelId: 'claude-opus-5', effort: 'high', allowGit: true };
    expect(patchDefaults(d, 'effort', 'low')).toEqual({ modelId: 'claude-opus-5', effort: 'low', allowGit: true });
    expect(patchDefaults(d, 'effort', '')).toEqual({ modelId: 'claude-opus-5', allowGit: true });
    expect(patchDefaults(d, 'allowGit', 'no')).toEqual({ modelId: 'claude-opus-5', effort: 'high', allowGit: false });
    expect(patchDefaults(d, 'allowGit', '')).toEqual({ modelId: 'claude-opus-5', effort: 'high' });
    expect(patchDefaults({}, 'runtime', 'wsl')).toEqual({ runtime: 'wsl' });
    // pure
    expect(d).toEqual({ modelId: 'claude-opus-5', effort: 'high', allowGit: true });
  });

  // multi-account FR-20: a project can pre-fill the new-session ACCOUNT field.
  it('offers an account select only once a SECOND account exists', () => {
    expect(defaultFieldDefs(MODELS, {}, true, []).map((d) => d.key)).not.toContain('accountId');
    expect(defaultFieldDefs(MODELS, {}, true, [{ id: 'default', label: 'Default' }]).map((d) => d.key)).not.toContain(
      'accountId',
    );

    const defs = defaultFieldDefs(MODELS, {}, true, [
      { id: 'default', label: 'Default' },
      { id: 'a1', label: 'perso' },
    ]);
    expect(defs[0].key).toBe('accountId');
    expect(defs[0].options).toEqual([
      { value: '', label: 'inherit' },
      { value: 'default', label: 'Default' },
      { value: 'a1', label: 'perso' },
    ]);
  });

  it('patches and clears the account default like every other field', () => {
    expect(patchDefaults({ modelId: 'm' }, 'accountId', 'a1')).toEqual({ modelId: 'm', accountId: 'a1' });
    expect(patchDefaults({ modelId: 'm', accountId: 'a1' }, 'accountId', '')).toEqual({ modelId: 'm' });
    expect(defaultsSelectValue({ accountId: 'a1' }, 'accountId')).toBe('a1');
    expect(defaultsSelectValue({}, 'accountId')).toBe('');
  });

  // session-profiles FR-20: a project can pre-fill the new-session PROFILE field.
  it('offers a profile select once at least one profile exists — unlike account it needs no SECOND', () => {
    expect(defaultFieldDefs(MODELS, {}, true, [], []).map((d) => d.key)).not.toContain('profileId');

    const defs = defaultFieldDefs(MODELS, {}, true, [], [{ id: 'p1', name: 'agent-architect' }]);
    expect(defs[0].key).toBe('profileId');
    expect(defs[0].options).toEqual([
      { value: '', label: 'inherit' },
      { value: 'p1', label: 'agent-architect' },
    ]);
  });

  it('patches and clears the profile default like every other field', () => {
    expect(patchDefaults({ modelId: 'm' }, 'profileId', 'p1')).toEqual({ modelId: 'm', profileId: 'p1' });
    expect(patchDefaults({ modelId: 'm', profileId: 'p1' }, 'profileId', '')).toEqual({ modelId: 'm' });
    expect(defaultsSelectValue({ profileId: 'p1' }, 'profileId')).toBe('p1');
    expect(defaultsSelectValue({}, 'profileId')).toBe('');
  });
});

// ---------- standards rules editing (FR-34.3/FR-35, §7 case 11) ----------

describe('standards rules editing', () => {
  it('strips newlines, trims, and caps a pasted rule (§7 case 11)', () => {
    expect(sanitizeRuleText('  a\nb\r\nc  ')).toBe('a b c');
    expect(sanitizeRuleText('x'.repeat(MAX_RULE_LENGTH + 20))).toHaveLength(MAX_RULE_LENGTH);
    expect(sanitizeRuleText('   ')).toBe('');
  });

  it('appends a sanitized rule and ignores an empty one', () => {
    expect(addRule(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addRule(['a'], '   ')).toEqual(['a']);
    const full = Array.from({ length: MAX_RULES }, (_, i) => `r${i}`);
    expect(addRule(full, 'one more')).toHaveLength(MAX_RULES); // FR-13 bound respected client-side
  });

  it('moves a rule up and down, clamping at the ends', () => {
    expect(moveRule(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRule(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveRule(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveRule(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('drops a rule by index', () => {
    expect(dropRule(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(dropRule(['a'], 5)).toEqual(['a']);
  });

  it('replaces a rule, leaving it untouched when the edit is emptied', () => {
    expect(replaceRule(['a', 'b'], 1, ' B ')).toEqual(['a', 'B']);
    expect(replaceRule(['a', 'b'], 1, '   ')).toEqual(['a', 'b']);
    expect(replaceRule(['a', 'b'], 9, 'x')).toEqual(['a', 'b']);
  });
});

// ---------- new-session project field (FR-22/FR-30) ----------

describe('newSessionProjectOptions (FR-22/§8 D)', () => {
  it('lists "— none —" first, then every project, flagging missing roots', () => {
    const list = [
      proj({ id: 'p1', name: 'francois', root: 'D:/francois' }),
      proj({ id: 'p2', name: 'infra', root: 'D:/ops', rootExists: false }),
    ];
    expect(newSessionProjectOptions(list)).toEqual([
      { value: '', label: '— none —', missing: false },
      { value: 'p1', label: 'francois', missing: false },
      { value: 'p2', label: 'infra', missing: true },
    ]);
  });
});

// ---------- IPC guard (FR-35: the modal never throws) ----------

describe('safeCall (FR-35)', () => {
  it('passes a resolved Result straight through', async () => {
    await expect(safeCall(Promise.resolve({ ok: true as const, data: 1 }))).resolves.toEqual({ ok: true, data: 1 });
  });

  it('turns a rejection into an ok:false INTERNAL result', async () => {
    const r = await safeCall<number>(Promise.reject(new Error('bridge down')));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(r.error.message).toBe('bridge down');
    }
  });
});

// ---------- FR-27: the board's visible set (project scope AND the '/' query) ----------

describe('visibleSessions (FR-27)', () => {
  const list = [
    sess('alpha', 'p1'),
    sess('beta', 'p1'),
    sess('gamma', 'p2'),
    sess('loose'), // unlinked
  ];

  it('returns every session when neither filter is active', () => {
    expect(visibleSessions(list, null, null).map((s) => s.id)).toEqual(['alpha', 'beta', 'gamma', 'loose']);
    expect(visibleSessions(list, null, '')).toHaveLength(4);
  });

  it('applies the project scope alone', () => {
    expect(visibleSessions(list, 'p1', null).map((s) => s.id)).toEqual(['alpha', 'beta']);
    // an unlinked session belongs to no project and is never in a scoped view
    expect(visibleSessions(list, 'p2', null).map((s) => s.id)).toEqual(['gamma']);
  });

  it('applies the / query alone, over name and cwd, case-insensitively', () => {
    expect(visibleSessions(list, null, 'ALP').map((s) => s.id)).toEqual(['alpha']);
    expect(visibleSessions(list, null, 'd:/x')).toHaveLength(4); // every fixture shares a cwd
  });

  it('ANDs the two — the query narrows WITHIN the scope, never outside it', () => {
    expect(visibleSessions(list, 'p1', 'a').map((s) => s.id)).toEqual(['alpha', 'beta']);
    expect(visibleSessions(list, 'p1', 'beta').map((s) => s.id)).toEqual(['beta']);
    // 'gamma' matches the query but is out of scope — the AND must exclude it
    expect(visibleSessions(list, 'p1', 'gamma')).toEqual([]);
  });

  it('is the count the pane header shows — post-BOTH-filters', () => {
    expect(visibleSessions(list, 'p1', 'beta')).toHaveLength(1);
    expect(visibleSessions(list, null, 'beta')).toHaveLength(1);
    expect(visibleSessions(list, 'p1', null)).toHaveLength(2);
  });

  it('a scope with no sessions yields empty rather than falling back to all', () => {
    expect(visibleSessions(list, 'p-none', null)).toEqual([]);
  });
});

// ---------- FR-39: where a scope switch lands ----------

describe('firstSessionInProject (FR-39)', () => {
  const list = [sess('loose'), sess('alpha', 'p1'), sess('beta', 'p1'), sess('gamma', 'p2')];

  it('is the first session the board would list for that project', () => {
    expect(firstSessionInProject(list, 'p1')?.id).toBe('alpha');
    expect(firstSessionInProject(list, 'p2')?.id).toBe('gamma');
  });

  it('is null for a project holding no sessions — what opens the new-session modal', () => {
    expect(firstSessionInProject(list, 'p-empty')).toBeNull();
    expect(firstSessionInProject([], 'p1')).toBeNull();
  });

  it('never claims an unlinked session, even when it is first in the list', () => {
    expect(firstSessionInProject([sess('loose')], 'p1')).toBeNull();
  });
});

// ---------- edge cases named by the review ----------

describe('empty-input edges', () => {
  it('buildSwitcherRows with no projects still offers the All row', () => {
    const rows = buildSwitcherRows([], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeNull();
    expect(rows[0].selected).toBe(true);
  });

  it('newSessionProjectOptions with no projects is just the none option', () => {
    const opts = newSessionProjectOptions([]);
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe('');
  });

  it('projectCountLabel singularises', () => {
    expect(projectCountLabel(0)).toBe('0 projects');
    expect(projectCountLabel(1)).toBe('1 project');
    expect(projectCountLabel(2)).toBe('2 projects');
  });

  it('effortOptions: a KNOWN model advertising no efforts yields none, not the union', () => {
    const models: ModelInfo[] = [
      { id: 'quiet', label: 'Quiet' }, // efforts undefined
      { id: 'loud', label: 'Loud', efforts: ['low', 'high'] },
    ];
    // the bug: `?.efforts` being undefined fell through to the union branch
    expect(effortOptions(models, 'quiet')).toEqual([]);
    expect(effortOptions(models, 'empty-list')).toEqual(['low', 'high']); // unknown id ⇒ union
    expect(effortOptions(models, 'loud')).toEqual(['low', 'high']);
  });

  it('safeCall stringifies a non-Error rejection', async () => {
    const r = await safeCall<number>(Promise.reject('plain string'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('plain string');
  });

  it('standardsFooterPath keeps the root separator on a mixed-separator root', () => {
    expect(standardsFooterPath('D:/a\b')).toContain('CLAUDE.md');
  });
});

// ---------- modal section errors (§6c: collapsed error state) ----------

describe('EMPTY_SECTION_ERRORS', () => {
  it('starts every section clear', () => {
    expect(EMPTY_SECTION_ERRORS).toEqual({ list: null, identity: null, defaults: null, standards: null });
  });
});

// ---------- FR-34: the Identity commit guard ----------

describe('canCommitIdentity', () => {
  it('refuses when the draft belongs to a DIFFERENT project than the selection', () => {
    // The regression: focus project A's name field, click project B's row, click
    // away. The blur fires with A's text while B is selected — committing there
    // renamed B to A's name, with no typing involved at all.
    expect(canCommitIdentity('A', 'B', 'name-of-A', 'name-of-B')).toBe(false);
  });

  it('allows a real edit on the project the draft actually belongs to', () => {
    expect(canCommitIdentity('A', 'A', 'renamed', 'original')).toBe(true);
  });

  it('treats an unchanged draft as a no-op — a blur fires on every focus traversal', () => {
    expect(canCommitIdentity('A', 'A', 'same', 'same')).toBe(false);
    expect(canCommitIdentity('A', 'A', '  same  ', 'same')).toBe(false);
  });

  it('refuses an empty or whitespace-only draft rather than sending it to be rejected', () => {
    expect(canCommitIdentity('A', 'A', '', 'original')).toBe(false);
    expect(canCommitIdentity('A', 'A', '   ', 'original')).toBe(false);
  });

  it('refuses when there is no selection or no stored value to compare against', () => {
    expect(canCommitIdentity(null, null, 'x', 'y')).toBe(false);
    expect(canCommitIdentity('A', 'A', 'x', undefined)).toBe(false);
    // a draft owned by nothing must never be written to a real selection
    expect(canCommitIdentity(null, 'A', 'x', 'y')).toBe(false);
  });
});

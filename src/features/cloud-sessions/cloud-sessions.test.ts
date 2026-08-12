// cloud-sessions (specs/cloud-sessions.md) — the feature's pure logic: ref
// parsing (FR-3's frontend mirror), the degrade-tolerant list fold (FR-2/FR-17),
// the adoption phase record the modal renders instead of a spinner (FR-7/FR-15),
// the Adopt guard (FR-12/FR-14) and the error copy (§7 #4: the phrase
// "Remote Control" must never reach this feature's UI).

import { describe, expect, it } from 'vitest';
import type { AppError, CloudProvenance } from '../../../contract/common';
import type { CloudListData, CloudSession } from '../../../contract/cloud-sessions';
import {
  ADOPT_ONE_WAY_HINT,
  ADOPT_STEP_LABELS,
  CLOUD_ONE_WAY_LINE,
  DEGRADED_LINE,
  EMPTY_LIST_LINE,
  adoptRequest,
  applyCloudEvent,
  canAdopt,
  checkoutWarning,
  cloudChipTitle,
  cloudErrorMessage,
  cloudListRender,
  cloudListView,
  cloudRowMeta,
  cloudRowTitle,
  failAdopt,
  isAdoptTerminal,
  parseCloudRef,
  projectAfterResolve,
  shortCloudId,
  startAdopt,
  stepDotColor,
  stepState,
  type AdoptProgress,
  type CloudListState,
} from './cloud-sessions';

const ID = 'session_01Mo4r8N2qZBTbU4V647cis4';

const session = (over: Partial<CloudSession> = {}): CloudSession => ({
  id: ID,
  title: null,
  repo: null,
  branch: null,
  updatedAt: null,
  ...over,
});

// ---------- FR-3: the ref the user pastes ----------

describe('parseCloudRef', () => {
  it('accepts a bare session_… / cse_… id', () => {
    expect(parseCloudRef(ID)).toBe(ID);
    expect(parseCloudRef('cse_abc123')).toBe('cse_abc123');
  });

  it('trims surrounding whitespace (a paste carries it)', () => {
    expect(parseCloudRef(`  ${ID}\n`)).toBe(ID);
  });

  it('accepts a claude.ai/code URL with or without scheme, slash or query', () => {
    expect(parseCloudRef(`https://claude.ai/code/${ID}`)).toBe(ID);
    expect(parseCloudRef(`http://claude.ai/code/${ID}/`)).toBe(ID);
    expect(parseCloudRef(`claude.ai/code/${ID}?tab=diff`)).toBe(ID);
    expect(parseCloudRef(`https://www.claude.ai/code/${ID}#top`)).toBe(ID);
  });

  it('refuses anything else rather than guessing', () => {
    expect(parseCloudRef('')).toBeNull();
    expect(parseCloudRef('   ')).toBeNull();
    expect(parseCloudRef('https://example.com/code/session_abc')).toBeNull();
    expect(parseCloudRef('https://claude.ai/chat/session_abc')).toBeNull();
    expect(parseCloudRef('hello world')).toBeNull();
    expect(parseCloudRef('session_')).toBeNull();
  });
});

describe('shortCloudId', () => {
  it('drops the id prefix and keeps a legible head', () => {
    expect(shortCloudId(ID)).toBe('01Mo4r8N');
    expect(shortCloudId('cse_abc')).toBe('abc');
  });

  it('returns an unknown-shaped id verbatim-ish rather than emptying it', () => {
    expect(shortCloudId('weird')).toBe('weird');
    expect(shortCloudId('')).toBe('');
  });
});

// ---------- honest row rendering (§Data shown: every field can be null) ----------

describe('cloudRowTitle / cloudRowMeta', () => {
  it('falls back to the short id when the API returned no title', () => {
    expect(cloudRowTitle(session())).toBe('01Mo4r8N');
    expect(cloudRowTitle(session({ title: '   ' }))).toBe('01Mo4r8N');
    expect(cloudRowTitle(session({ title: 'Fix the login bug' }))).toBe('Fix the login bug');
  });

  it('hides absent metadata instead of synthesizing it', () => {
    expect(cloudRowMeta(session())).toEqual([]);
    expect(cloudRowMeta(session({ repo: 'acme/api', branch: 'fix/login' }))).toEqual(['acme/api', 'fix/login']);
  });

  it('renders updatedAt as relative time when present', () => {
    const now = 1_000_000;
    expect(cloudRowMeta(session({ updatedAt: now - 120_000 }), now)).toEqual(['2m']);
  });
});

// ---------- FR-2 / FR-17: the list degrades to empty, never to wrong ----------

describe('cloudListView', () => {
  const data = (over: Partial<CloudListData> = {}): CloudListData => ({
    sessions: [session()],
    degraded: false,
    ...over,
  });

  it('passes a healthy list through', () => {
    expect(cloudListView({ ok: true, data: data() })).toEqual({
      sessions: [session()],
      degraded: false,
      error: null,
    });
  });

  it('keeps degraded:true with no error — offline is the common case, not a failure', () => {
    expect(cloudListView({ ok: true, data: { sessions: [], degraded: true } })).toEqual({
      sessions: [],
      degraded: true,
      error: null,
    });
  });

  it('surfaces an auth failure as an error, because that one is actionable', () => {
    const error: AppError = { code: 'CLOUD_AUTH_EXPIRED', message: 'expired' };
    expect(cloudListView({ ok: false, error })).toEqual({ sessions: [], degraded: false, error });
  });

  it('treats a malformed payload as degraded rather than throwing', () => {
    const broken = { ok: true, data: null } as unknown as { ok: true; data: CloudListData };
    expect(cloudListView(broken)).toEqual({ sessions: [], degraded: true, error: null });
    const noArray = { ok: true, data: { sessions: 'nope', degraded: false } } as unknown as {
      ok: true;
      data: CloudListData;
    };
    expect(cloudListView(noArray)).toEqual({ sessions: [], degraded: true, error: null });
  });

  it('drops entries with no usable id', () => {
    const mixed = {
      ok: true,
      data: { sessions: [session(), { title: 'no id' }], degraded: false },
    } as unknown as { ok: true; data: CloudListData };
    expect(cloudListView(mixed).sessions).toEqual([session()]);
  });
});

describe('cloudListRender', () => {
  const state = (over: Partial<CloudListState> = {}): CloudListState => ({
    sessions: [],
    degraded: false,
    error: null,
    loading: false,
    ...over,
  });

  it('shows the skeleton while the fetch is in flight — the paste field is usable meanwhile', () => {
    expect(cloudListRender(state({ loading: true }))).toEqual({ kind: 'loading' });
  });

  it('renders the rows when there are rows', () => {
    expect(cloudListRender(state({ sessions: [session()] }))).toEqual({ kind: 'rows' });
  });

  it('renders the calm degraded line, not an error — offline is the COMMON state (FR-17)', () => {
    expect(cloudListRender(state({ degraded: true }))).toEqual({ kind: 'note', line: DEGRADED_LINE });
  });

  it('says the account has none only when the fetch actually succeeded', () => {
    expect(cloudListRender(state())).toEqual({ kind: 'note', line: EMPTY_LIST_LINE });
  });

  it('never claims the account has no cloud sessions when auth refused — we never got to look', () => {
    const error: AppError = { code: 'CLOUD_AUTH_EXPIRED', message: 'Remote Control session expired' };
    const rendered = cloudListRender(state({ error }));
    expect(rendered.kind).toBe('error');
    const line = rendered.kind === 'error' ? rendered.line : '';
    expect(line).toBe(cloudErrorMessage(error));
    expect(line).not.toBe(EMPTY_LIST_LINE);
    expect(line).not.toBe(DEGRADED_LINE);
    // §7 #4: the CLI's own wording never reaches this feature's UI.
    expect(line).not.toMatch(/remote control/i);
  });

  it('prefers the actionable refusal over the calm line when the core sent both', () => {
    const error: AppError = { code: 'CLOUD_AUTH_REQUIRED', message: 'no token' };
    expect(cloudListRender(state({ degraded: true, error })).kind).toBe('error');
  });
});

// ---------- FR-7 / FR-15: phases, not a spinner ----------

describe('adoption progress', () => {
  const p0 = startAdopt(ID);

  it('starts at resolving with no error and no session', () => {
    expect(p0).toEqual({ ref: ID, step: 'resolving', error: null, sessionId: null });
  });

  it('advances on every phase transition', () => {
    const p1 = applyCloudEvent(p0, { type: 'cloud.adopt', ref: ID, state: { phase: 'preparing' } });
    expect(p1?.step).toBe('preparing');
    const p2 = applyCloudEvent(p1, { type: 'cloud.adopt', ref: ID, state: { phase: 'teleporting' } });
    expect(p2?.step).toBe('teleporting');
    const p3 = applyCloudEvent(p2, { type: 'cloud.adopt', ref: ID, state: { phase: 'hydrating' } });
    expect(p3?.step).toBe('hydrating');
    const p4 = applyCloudEvent(p3, { type: 'cloud.adopt', ref: ID, state: { phase: 'ready', sessionId: 's1' } });
    expect(p4).toEqual({ ref: ID, step: 'ready', error: null, sessionId: 's1' });
  });

  it('ignores an event for another ref — a second adoption never hijacks this modal', () => {
    const other = applyCloudEvent(p0, { type: 'cloud.adopt', ref: 'session_other', state: { phase: 'ready', sessionId: 'x' } });
    expect(other).toEqual(p0);
  });

  it('is a no-op with nothing in flight', () => {
    expect(applyCloudEvent(null, { type: 'cloud.adopt', ref: ID, state: { phase: 'preparing' } })).toBeNull();
  });

  it('keeps the step it failed at, so the list stops on that row', () => {
    const error: AppError = { code: 'CLOUD_REPO_MISMATCH', message: 'different repo' };
    const p1 = applyCloudEvent(p0, { type: 'cloud.adopt', ref: ID, state: { phase: 'teleporting' } });
    const failed = applyCloudEvent(p1, { type: 'cloud.adopt', ref: ID, state: { phase: 'failed', error } });
    expect(failed).toEqual({ ref: ID, step: 'teleporting', error, sessionId: null });
  });

  it('is terminal once it failed or readied — a late event never revives it', () => {
    const error: AppError = { code: 'CLOUD_ADOPT_FAILED', message: 'exited' };
    const failed = applyCloudEvent(p0, { type: 'cloud.adopt', ref: ID, state: { phase: 'failed', error } });
    expect(applyCloudEvent(failed, { type: 'cloud.adopt', ref: ID, state: { phase: 'hydrating' } })).toEqual(failed);
    const ready = applyCloudEvent(p0, { type: 'cloud.adopt', ref: ID, state: { phase: 'ready', sessionId: 's1' } });
    expect(applyCloudEvent(ready, { type: 'cloud.adopt', ref: ID, state: { phase: 'teleporting' } })).toEqual(ready);
  });

  it('folds a command-level refusal onto the current step (no event ever arrives for those)', () => {
    const error: AppError = { code: 'INVALID_INPUT', message: 'confirmation required' };
    expect(failAdopt(p0, error)).toEqual({ ref: ID, step: 'resolving', error, sessionId: null });
    expect(failAdopt(null, error)).toBeNull();
  });

  it('reports terminality, so a late command result never overwrites a detailed failure', () => {
    const error: AppError = { code: 'CLOUD_REPO_MISMATCH', message: 'different repo' };
    expect(isAdoptTerminal(p0)).toBe(false);
    expect(isAdoptTerminal({ ...p0, error })).toBe(true);
    expect(isAdoptTerminal({ ...p0, step: 'ready', sessionId: 's1' })).toBe(true);
  });
});

describe('stepState', () => {
  const at = (step: AdoptProgress['step'], over: Partial<AdoptProgress> = {}): AdoptProgress => ({
    ref: ID,
    step,
    error: null,
    sessionId: null,
    ...over,
  });

  it('marks earlier steps done, the current one current and the rest pending', () => {
    const p = at('teleporting');
    expect(stepState('resolving', p)).toBe('done');
    expect(stepState('preparing', p)).toBe('done');
    expect(stepState('teleporting', p)).toBe('current');
    expect(stepState('hydrating', p)).toBe('pending');
    expect(stepState('ready', p)).toBe('pending');
  });

  it('marks the failed step failed and leaves the rest pending', () => {
    const p = at('preparing', { error: { code: 'NOT_A_GIT_REPO', message: 'not a repo' } });
    expect(stepState('resolving', p)).toBe('done');
    expect(stepState('preparing', p)).toBe('failed');
    expect(stepState('teleporting', p)).toBe('pending');
  });

  it('marks ready done once the session exists', () => {
    const p = at('ready', { sessionId: 's1' });
    expect(stepState('ready', p)).toBe('done');
    expect(stepState('hydrating', p)).toBe('done');
  });

  it('gives the current step the one acid per view, and never colour alone', () => {
    expect(stepDotColor('current')).toBe('var(--accent)');
    expect(stepDotColor('done')).toBe('var(--success)');
    expect(stepDotColor('failed')).toBe('var(--error)');
    expect(stepDotColor('pending')).toBe('var(--text-disabled)');
    // Each row carries a text label too (accessibility: never colour alone).
    expect(ADOPT_STEP_LABELS.hydrating).toBe('Loading history');
    expect(Object.values(ADOPT_STEP_LABELS).every((l) => l.length > 0)).toBe(true);
  });
});

// ---------- FR-12 / FR-14: what makes Adopt clickable ----------

describe('canAdopt', () => {
  const form = { ref: ID, projectId: 'p1', destination: 'worktree' as const, confirmed: false };

  it('needs a ref and a project', () => {
    expect(canAdopt(form)).toBe(true);
    expect(canAdopt({ ...form, ref: '   ' })).toBe(false);
    expect(canAdopt({ ...form, projectId: '' })).toBe(false);
  });

  it('refuses a checkout landing until the destructive box is ticked (FR-12)', () => {
    expect(canAdopt({ ...form, destination: 'checkout' })).toBe(false);
    expect(canAdopt({ ...form, destination: 'checkout', confirmed: true })).toBe(true);
  });

  it('ignores a stale confirmation when the landing is a worktree', () => {
    expect(adoptRequest({ ...form, confirmed: true })).toEqual({
      ref: ID,
      projectId: 'p1',
      destination: 'worktree',
    });
  });

  it('sends confirmed:true only for a checkout landing (FR-12)', () => {
    expect(adoptRequest({ ...form, destination: 'checkout', confirmed: true })).toEqual({
      ref: ID,
      projectId: 'p1',
      destination: 'checkout',
      confirmed: true,
    });
  });

  it('sends the trimmed ref and an accountId only when one was chosen', () => {
    expect(adoptRequest({ ...form, ref: `  ${ID} ` }, 'acc1')).toEqual({
      ref: ID,
      projectId: 'p1',
      destination: 'worktree',
      accountId: 'acc1',
    });
  });
});

describe('projectAfterResolve', () => {
  it('fills the selector quietly when the repo matched a project', () => {
    expect(projectAfterResolve('', 'p1', false)).toBe('p1');
  });

  it('leaves it empty and required when nothing matched', () => {
    expect(projectAfterResolve('p-old', null, false)).toBe('');
  });

  it('never overwrites a project the user picked by hand', () => {
    expect(projectAfterResolve('p-mine', 'p1', true)).toBe('p-mine');
    expect(projectAfterResolve('p-mine', null, true)).toBe('p-mine');
  });
});

// ---------- §7 #4: honest text, and never the phrase "Remote Control" ----------

describe('cloudErrorMessage', () => {
  it('states the login rule for CLOUD_AUTH_REQUIRED', () => {
    expect(cloudErrorMessage({ code: 'CLOUD_AUTH_REQUIRED', message: 'no_access_token' })).toBe(
      'Cloud sessions need a claude.ai login — API key auth is not sufficient.',
    );
  });

  it('re-words the CLI’s Remote Control phrasing for every cloud code', () => {
    const msg = cloudErrorMessage({ code: 'CLOUD_AUTH_EXPIRED', message: 'Remote Control session expired' });
    expect(msg).not.toMatch(/remote control/i);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('names both repos on a mismatch when the core sent them', () => {
    const msg = cloudErrorMessage({
      code: 'CLOUD_REPO_MISMATCH',
      message: 'mismatch',
      detail: { sessionRepo: 'acme/api', currentRepo: 'acme/api-fork' },
    });
    expect(msg).toContain('acme/api');
    expect(msg).toContain('acme/api-fork');
  });

  it('degrades to a plain mismatch line when the detail is malformed', () => {
    const msg = cloudErrorMessage({ code: 'CLOUD_REPO_MISMATCH', message: 'mismatch', detail: 'nope' });
    expect(msg).not.toMatch(/remote control/i);
    expect(msg).toContain('repository');
  });

  it('names the phase a stall happened in', () => {
    const msg = cloudErrorMessage({ code: 'CLOUD_ADOPT_STALLED', message: 'stalled', detail: { phase: 'teleporting' } });
    expect(msg.toLowerCase()).toContain('teleporting');
    // …and stays a whole sentence when the core sent no usable phase.
    expect(cloudErrorMessage({ code: 'CLOUD_ADOPT_STALLED', message: 'stalled' })).not.toContain('undefined');
  });

  it('points at the log a post-spawn failure wrote', () => {
    // A stall used to render as "the adoption stopped" and nothing else — the
    // PTY is the only witness to WHY, so the file holding it has to be named.
    const stalled = cloudErrorMessage({
      code: 'CLOUD_ADOPT_STALLED',
      message: 'stalled',
      detail: { phase: 'teleporting', logPath: '/Users/a/Library/francois/cloud-adopt.log' },
    });
    expect(stalled).toContain('cloud-adopt.log');
    expect(stalled.toLowerCase()).toContain('teleporting');
    const exited = cloudErrorMessage({
      code: 'CLOUD_ADOPT_FAILED',
      message: 'exited',
      detail: { logPath: '/Users/a/Library/francois/cloud-adopt.log' },
    });
    expect(exited).toContain('cloud-adopt.log');
    // An older core sends no logPath, and the message must not grow a stub.
    expect(cloudErrorMessage({ code: 'CLOUD_ADOPT_STALLED', message: 'stalled', detail: { phase: 'teleporting' } })).not.toContain('undefined');
    expect(cloudErrorMessage({ code: 'CLOUD_ADOPT_FAILED', message: 'exited' })).not.toMatch(/is in\s*$/);
  });

  it('passes a non-cloud code’s own message through, scrubbed', () => {
    expect(cloudErrorMessage({ code: 'NOT_A_GIT_REPO', message: 'not a git repository' })).toBe('not a git repository');
    expect(cloudErrorMessage({ code: 'GIT_ERROR', message: 'Remote Control is unavailable' })).not.toMatch(/remote control/i);
  });

  it('never renders an empty line, whatever the core sent', () => {
    expect(cloudErrorMessage({ code: 'INTERNAL', message: '' }).length).toBeGreaterThan(0);
  });
});

// ---------- copy the design brief pins verbatim ----------

describe('feature copy', () => {
  it('keeps the degraded line calm and points at the paste field (FR-17)', () => {
    expect(DEGRADED_LINE).toBe("Couldn't load your cloud sessions — paste a link instead.");
  });

  it('does not claim a fetch failed when the account simply has no cloud sessions', () => {
    // A healthy, empty list is NOT the degraded state: telling the user we
    // couldn't load something we loaded fine sends them debugging their network.
    expect(EMPTY_LIST_LINE).not.toBe(DEGRADED_LINE);
    expect(EMPTY_LIST_LINE.toLowerCase()).not.toContain("couldn't");
    expect(EMPTY_LIST_LINE.length).toBeGreaterThan(0);
  });

  it('names the branch and the project in the checkout confirmation', () => {
    expect(checkoutWarning('api', 'fix/login')).toBe(
      'Teleport will stash uncommitted changes in api and check out fix/login.',
    );
  });

  it('says so honestly when the branch is not known yet', () => {
    const line = checkoutWarning('api', null);
    expect(line).toContain('api');
    expect(line).not.toContain('null');
  });

  it('states the one-way rule BEFORE adopting too, in the tense of a thing not yet done', () => {
    // The chip's line is retrospective ("Adopted from…"); the modal's hint has to
    // land the same rule while the decision is still ahead of the user — §7 #8
    // is about the moment they choose, not only about the session afterwards.
    expect(ADOPT_ONE_WAY_HINT).toContain('claude.ai');
    expect(ADOPT_ONE_WAY_HINT.toLowerCase()).toContain('one-way');
    expect(ADOPT_ONE_WAY_HINT).not.toMatch(/remote control/i);
    expect(ADOPT_ONE_WAY_HINT).not.toContain('Adopted from');
  });

  it('carries the one-way rule verbatim in the chip tooltip (FR-16)', () => {
    const cloud: CloudProvenance = { cloudSessionId: ID, adoptedAt: 1_000_000 };
    const title = cloudChipTitle(cloud, 1_000_000);
    expect(CLOUD_ONE_WAY_LINE).toBe(
      'Adopted from a cloud session. Work you do here does not go back to claude.ai.',
    );
    expect(title).toContain(CLOUD_ONE_WAY_LINE);
    // the id and the timestamp live in the tooltip, never on the chip face
    expect(title).toContain(ID);
  });
});

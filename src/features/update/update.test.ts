// self-update (specs/self-update.md) — frontend unit tests.
// Covers the zustand `update` slice (§6), the contract-typed invoke wrappers
// (§5, all three error codes), the launch/manual check + apply actions
// (FR-7/FR-9/FR-12/FR-18), and every render derivation the chip and the modal
// depend on (FR-8/FR-10/FR-11). No DOM framework is wired — UpdateChip.tsx and
// UpdateModal.tsx are thin renderers over these.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { UpdateCheck } from '../../../contract/self-update';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { appApplyUpdate, appCheckUpdate } from '../../lib/api';
import { useStore } from '../../lib/store';
import {
  BLOCKED_NOTE,
  MANUAL_NOTE,
  applyUpdate,
  checkUpdateManually,
  checkUpdateOnLaunch,
  resetLaunchCheck,
  runningSessionCount,
  updateChipView,
  updateModalView,
  updatePrimaryView,
  upToDateLine,
} from './update';

const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  current: '0.15.8',
  latest: '0.16.0',
  updateAvailable: true,
  method: 'npm',
  notes: '- fixed a thing',
  notesUrl: 'https://github.com/antoine-gmnz/francois/releases/tag/v0.16.0',
  command: 'npm i -g francois@latest',
  checkedAt: 1_700_000_000_000,
  ...over,
});

const session = (id: string, status: SessionMeta['status']): SessionMeta => ({
  id,
  name: id,
  cwd: '/tmp',
  model: { id: 'sonnet', label: 'Sonnet' },
  status,
  contextUsedTokens: 0,
  contextLimitTokens: 1,
  startedAt: 0,
  lastActivityAt: 0,
  permissionMode: 'default',
  runtime: 'native',
  accountId: 'default',
  agentRuntime: 'claude-code',
  protocol: 'anthropic',
});

/** Flush the microtask queue so promise chains inside the actions settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  resetLaunchCheck();
  useStore.setState({ update: null, updateModalOpen: false, updateBusy: false, updateError: null, sessions: [] });
});

// ---------------------------------------------------------------- store slice

describe('update store slice (§6)', () => {
  it('starts with no check, no modal, not busy, no error', () => {
    const s = useStore.getState();
    expect(s.update).toBeNull();
    expect(s.updateModalOpen).toBe(false);
    expect(s.updateBusy).toBe(false);
    expect(s.updateError).toBeNull();
  });

  it('setUpdate replaces the last check wholesale (FR-19)', () => {
    useStore.getState().setUpdate(check());
    useStore.getState().setUpdate(check({ latest: '0.17.0', notes: undefined }));
    const stored = useStore.getState().update;
    expect(stored?.latest).toBe('0.17.0');
    expect(stored?.notes).toBeUndefined();
  });
});

// ----------------------------------------------------------- invoke wrappers

describe('invoke wrappers (§5)', () => {
  it('appCheckUpdate calls app_check_update with no payload', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: check() });
    const res = await appCheckUpdate();
    expect(invokeMock).toHaveBeenCalledWith('app_check_update', undefined);
    expect(res.ok && res.data.latest).toBe('0.16.0');
  });

  it('appApplyUpdate calls app_apply_update with no payload', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { helperPid: 42, latest: '0.16.0', logPath: '/tmp/u/update.log' } });
    const res = await appApplyUpdate();
    expect(invokeMock).toHaveBeenCalledWith('app_apply_update', undefined);
    expect(res.ok && res.data.helperPid).toBe(42);
  });

  it('resolves (never rejects) an UPDATE_CHECK_FAILED Result', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'UPDATE_CHECK_FAILED', message: 'registry unreachable' } });
    const res = await appCheckUpdate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UPDATE_CHECK_FAILED');
  });

  it('resolves an UPDATE_BLOCKED Result carrying detail.running (FR-12)', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: { code: 'UPDATE_BLOCKED', message: '2 sessions running', detail: { running: 2 } },
    });
    const res = await appApplyUpdate();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UPDATE_BLOCKED');
      expect((res.error.detail as { running: number }).running).toBe(2);
    }
  });

  it('resolves an UPDATE_APPLY_FAILED Result (FR-18)', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'UPDATE_APPLY_FAILED', message: 'npm not found' } });
    const res = await appApplyUpdate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UPDATE_APPLY_FAILED');
  });
});

// ------------------------------------------------------------------ the chip

describe('updateChipView (FR-8)', () => {
  it('renders the running version, dim and inert (no tooltip), before any check', () => {
    expect(updateChipView(null, '0.15.8')).toEqual({ available: false, label: '0.15.8', title: '' });
  });

  it("falls back to 'dev' when the bundle version has not resolved yet", () => {
    expect(updateChipView(null, '').label).toBe('dev');
  });

  it('stays exactly as today when the check found nothing (FR-7 silence)', () => {
    const view = updateChipView(check({ updateAvailable: false, latest: '0.15.8' }), '0.15.8');
    expect(view.available).toBe(false);
    expect(view.label).toBe('0.15.8');
  });

  it('shows ↑ <latest> — the NEW version, not the current one — when an update is available', () => {
    const view = updateChipView(check(), '0.15.8');
    expect(view).toEqual({
      available: true,
      label: '↑ 0.16.0',
      title: 'Francois 0.16.0 is available',
    });
  });

  it('names the latest version even for a manual install — the chip is informational', () => {
    expect(updateChipView(check({ method: 'manual' }), '0.15.8').available).toBe(true);
  });
});

// ------------------------------------------------------- the primary action

describe('runningSessionCount (FR-12)', () => {
  it('counts only running sessions', () => {
    expect(runningSessionCount([session('a', 'running'), session('b', 'idle'), session('c', 'running')])).toBe(2);
    expect(runningSessionCount([session('a', 'done'), session('b', 'error')])).toBe(0);
    expect(runningSessionCount([])).toBe(0);
  });
});

describe('updatePrimaryView (FR-11, FR-12)', () => {
  it('offers the update on an npm install with nothing running', () => {
    expect(updatePrimaryView(check(), 0, false)).toEqual({ kind: 'apply', label: 'Update and restart' });
  });

  it('shows Updating… while the apply is in flight', () => {
    expect(updatePrimaryView(check(), 0, true)).toEqual({ kind: 'busy', label: 'Updating…' });
  });

  it('blocks on running sessions, naming the count in TEXT (FR-12)', () => {
    expect(updatePrimaryView(check(), 2, false)).toEqual({
      kind: 'blocked',
      label: '2 sessions running',
      note: BLOCKED_NOTE,
    });
    expect(updatePrimaryView(check(), 1, false)).toMatchObject({ kind: 'blocked', label: '1 session running' });
  });

  it('never renders a button for a manual install — the command takes its place (FR-11)', () => {
    expect(updatePrimaryView(check({ method: 'manual' }), 0, false)).toEqual({
      kind: 'manual',
      command: 'npm i -g francois@latest',
      note: MANUAL_NOTE,
    });
  });

  it('keeps the manual state even while sessions run — nothing here can quit the app', () => {
    expect(updatePrimaryView(check({ method: 'manual' }), 3, false).kind).toBe('manual');
  });
});

// ----------------------------------------------------------------- the modal

describe('updateModalView (FR-10, §7)', () => {
  it('carries the version transition, the notes and the release link', () => {
    const view = updateModalView(check(), null, 0, false);
    expect(view).toEqual({
      kind: 'available',
      current: '0.15.8',
      latest: '0.16.0',
      notes: '- fixed a thing',
      notesUrl: 'https://github.com/antoine-gmnz/francois/releases/tag/v0.16.0',
      primary: { kind: 'apply', label: 'Update and restart' },
      error: null,
    });
  });

  it('degrades to no notes when the GitHub body was unavailable, keeping the offer (FR-3)', () => {
    expect(updateModalView(check({ notes: undefined }), null, 0, false)).toMatchObject({ kind: 'available', notes: null });
    expect(updateModalView(check({ notes: '   ' }), null, 0, false)).toMatchObject({ notes: null });
  });

  it("reports up to date when latest equals current (manual check)", () => {
    expect(updateModalView(check({ updateAvailable: false, latest: '0.15.8' }), null, 0, false)).toEqual({
      kind: 'uptodate',
      current: '0.15.8',
    });
    expect(upToDateLine('0.15.8')).toBe("You're on the latest version (0.15.8)");
  });

  it('reports a failed check with its message and no version headline', () => {
    const view = updateModalView(null, { code: 'UPDATE_CHECK_FAILED', message: 'registry unreachable' }, 0, false);
    expect(view).toEqual({ kind: 'failed', message: 'registry unreachable' });
  });

  it('a failed check wins over a stale successful one — neither version is known now', () => {
    const view = updateModalView(check(), { code: 'UPDATE_CHECK_FAILED', message: 'offline' }, 0, false);
    expect(view.kind).toBe('failed');
  });

  it('falls back to a failed view when there is no check at all', () => {
    expect(updateModalView(null, null, 0, false).kind).toBe('failed');
  });

  it('keeps the offer on screen when the APPLY failed, showing the reason (FR-18)', () => {
    const view = updateModalView(check(), { code: 'UPDATE_APPLY_FAILED', message: 'npm not found' }, 0, false);
    expect(view).toMatchObject({ kind: 'available', error: 'npm not found' });
  });

  it('re-renders blocked with the live count when the core refused (FR-12)', () => {
    const view = updateModalView(
      check(),
      { code: 'UPDATE_BLOCKED', message: 'sessions running', detail: { running: 2 } },
      2,
      false,
    );
    expect(view).toMatchObject({ kind: 'available', primary: { kind: 'blocked', label: '2 sessions running' } });
  });
});

// ---------------------------------------------------------------- the checks

describe('checkUpdateOnLaunch (FR-7)', () => {
  it('records the result and never opens the modal', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: check() });
    await checkUpdateOnLaunch();
    expect(invokeMock).toHaveBeenCalledWith('app_check_update', undefined);
    expect(useStore.getState().update?.latest).toBe('0.16.0');
    expect(useStore.getState().updateModalOpen).toBe(false);
  });

  it('is SILENT on failure — no chip, no error, no modal', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'UPDATE_CHECK_FAILED', message: 'offline' } });
    await checkUpdateOnLaunch();
    const s = useStore.getState();
    expect(s.update).toBeNull();
    expect(s.updateError).toBeNull();
    expect(s.updateModalOpen).toBe(false);
  });

  it('swallows a bridge rejection', async () => {
    invokeMock.mockRejectedValue(new Error('no ipc'));
    await expect(checkUpdateOnLaunch()).resolves.toBeUndefined();
    expect(useStore.getState().updateError).toBeNull();
  });

  it('runs exactly once per app run, even under StrictMode double-mount', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: check() });
    await checkUpdateOnLaunch();
    await checkUpdateOnLaunch();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('checkUpdateManually (FR-9)', () => {
  it('opens the modal on a successful check', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: check({ updateAvailable: false }) });
    await checkUpdateManually();
    const s = useStore.getState();
    expect(s.update?.updateAvailable).toBe(false);
    expect(s.updateError).toBeNull();
    expect(s.updateModalOpen).toBe(true);
  });

  it('ALSO reports back on failure — the only path that surfaces a failed check', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'UPDATE_CHECK_FAILED', message: 'offline' } });
    await checkUpdateManually();
    const s = useStore.getState();
    expect(s.updateError).toEqual({ code: 'UPDATE_CHECK_FAILED', message: 'offline' });
    expect(s.updateModalOpen).toBe(true);
  });

  it('reports a bridge rejection as a failed check', async () => {
    invokeMock.mockRejectedValue(new Error('no ipc'));
    await checkUpdateManually();
    expect(useStore.getState().updateError?.code).toBe('UPDATE_CHECK_FAILED');
    expect(useStore.getState().updateModalOpen).toBe(true);
  });

  it('clears a previous apply error so a fresh check starts clean', async () => {
    useStore.getState().setUpdateError({ code: 'UPDATE_APPLY_FAILED', message: 'npm not found' });
    invokeMock.mockResolvedValue({ ok: true, data: check() });
    await checkUpdateManually();
    expect(useStore.getState().updateError).toBeNull();
  });

  it('is not gated by the launch check — the user can ask any number of times', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: check() });
    await checkUpdateOnLaunch();
    await checkUpdateManually();
    await checkUpdateManually();
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
});

// ----------------------------------------------------------------- the apply

describe('applyUpdate (FR-12, FR-16, FR-18, §7)', () => {
  beforeEach(() => {
    useStore.setState({ update: check(), updateModalOpen: true });
  });

  it('stays busy after the ack — the window is closing, there is no success state (FR-16)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { helperPid: 7, latest: '0.16.0', logPath: '/tmp/u/update.log' } });
    await applyUpdate();
    expect(invokeMock).toHaveBeenCalledWith('app_apply_update', undefined);
    expect(useStore.getState().updateBusy).toBe(true);
    expect(useStore.getState().updateError).toBeNull();
  });

  it('records UPDATE_BLOCKED and frees the button again (FR-12)', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: { code: 'UPDATE_BLOCKED', message: '2 sessions running', detail: { running: 2 } },
    });
    await applyUpdate();
    expect(useStore.getState().updateError?.code).toBe('UPDATE_BLOCKED');
    expect(useStore.getState().updateBusy).toBe(false);
    expect(useStore.getState().updateModalOpen).toBe(true);
  });

  it('records UPDATE_APPLY_FAILED and leaves the app open (FR-18)', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'UPDATE_APPLY_FAILED', message: 'npm not found' } });
    await applyUpdate();
    expect(useStore.getState().updateError?.message).toBe('npm not found');
    expect(useStore.getState().updateBusy).toBe(false);
  });

  it('reports a bridge rejection as UPDATE_APPLY_FAILED', async () => {
    invokeMock.mockRejectedValue(new Error('no ipc'));
    await applyUpdate();
    expect(useStore.getState().updateError?.code).toBe('UPDATE_APPLY_FAILED');
    expect(useStore.getState().updateBusy).toBe(false);
  });

  it('a second call while busy never reaches the core (§7)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { helperPid: 7, latest: '0.16.0', logPath: '/tmp/u/update.log' } });
    await applyUpdate();
    await applyUpdate();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('never invokes for a manual install (FR-11/FR-18)', async () => {
    useStore.setState({ update: check({ method: 'manual' }) });
    await applyUpdate();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useStore.getState().updateBusy).toBe(false);
  });

  it('never invokes with no update to apply', async () => {
    useStore.setState({ update: check({ updateAvailable: false }) });
    await applyUpdate();
    useStore.setState({ update: null, updateBusy: false });
    await applyUpdate();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('clears a previous error when a retry starts', async () => {
    useStore.getState().setUpdateError({ code: 'UPDATE_APPLY_FAILED', message: 'npm not found' });
    invokeMock.mockImplementation(async () => {
      expect(useStore.getState().updateError).toBeNull();
      return { ok: true, data: { helperPid: 7, latest: '0.16.0', logPath: '/tmp/u/update.log' } };
    });
    await applyUpdate();
    await tick();
    expect(useStore.getState().updateError).toBeNull();
  });
});

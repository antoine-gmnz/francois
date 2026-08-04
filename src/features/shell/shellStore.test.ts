// multiple-shells §6: the shell store's own state transitions — roster
// upsert/remove, status merge (FR-17: position/name untouched), active-id
// memory (FR-15), and the unread false→true-only transition (FR-14). The
// global event-listener wiring (initShellEvents) is exercised through the
// api.ts `onShellEvent` seam in shell-event-routing.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ShellInfo } from '../../../contract/shell-terminal';
import { useShellStore } from './shellStore';

function shell(id: string, patch: Partial<ShellInfo> = {}): ShellInfo {
  return { id, sessionId: 's1', name: `zsh ${id}`, shellName: 'zsh', cwd: '/tmp', alive: true, ...patch };
}

beforeEach(() => {
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
});

describe('setShells / upsertShell', () => {
  it('setShells replaces the whole roster for a session, refreshed by every ensure (§6)', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b')]);
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('upsertShell appends a new shell and updates an existing one in place', () => {
    const store = useShellStore.getState();
    store.setShells('s1', [shell('a')]);
    store.upsertShell('s1', shell('b'));
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a', 'b']);

    store.upsertShell('s1', shell('a', { name: 'renamed' }));
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a', 'b']); // position unchanged
    expect(useShellStore.getState().shells.s1[0].name).toBe('renamed');
  });

  it('upsertShell into an unknown session starts a fresh list', () => {
    useShellStore.getState().upsertShell('new-session', shell('a'));
    expect(useShellStore.getState().shells['new-session'].map((s) => s.id)).toEqual(['a']);
  });
});

describe('removeShell', () => {
  it('drops the entry, leaving the rest of the order intact', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b'), shell('c')]);
    useShellStore.getState().removeShell('s1', 'b');
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('is a no-op for a session with no roster', () => {
    const before = useShellStore.getState().shells;
    useShellStore.getState().removeShell('nope', 'x');
    expect(useShellStore.getState().shells).toBe(before);
  });
});

describe('setShellStatus', () => {
  it('merges alive/exitCode without touching name or position (FR-17 restart-in-place)', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b', { name: 'custom' })]);
    useShellStore.getState().setShellStatus('s1', 'b', false, 7);
    const list = useShellStore.getState().shells.s1;
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ name: 'custom', alive: false, exitCode: 7 });

    useShellStore.getState().setShellStatus('s1', 'b', true, undefined);
    expect(useShellStore.getState().shells.s1[1]).toMatchObject({ name: 'custom', alive: true, exitCode: undefined });
  });

  it('is a no-op for an unknown shellId', () => {
    useShellStore.getState().setShells('s1', [shell('a')]);
    const before = useShellStore.getState().shells.s1;
    useShellStore.getState().setShellStatus('s1', 'ghost', false, 1);
    expect(useShellStore.getState().shells.s1).toBe(before);
  });
});

describe('activeShellId', () => {
  it('remembers and clears per session (FR-15)', () => {
    useShellStore.getState().setActiveShellId('s1', 'a');
    expect(useShellStore.getState().activeShellId.s1).toBe('a');
    useShellStore.getState().clearActiveShellId('s1');
    expect(useShellStore.getState().activeShellId.s1).toBeUndefined();
  });

  it('clearActiveShellId is a no-op when nothing is set', () => {
    const before = useShellStore.getState().activeShellId;
    useShellStore.getState().clearActiveShellId('s1');
    expect(useShellStore.getState().activeShellId).toBe(before);
  });
});

describe('unread', () => {
  it('markUnread only mutates state on the false → true transition (FR-14)', () => {
    const store = useShellStore.getState();
    store.markUnread('a');
    const afterFirst = useShellStore.getState().unread;
    expect(afterFirst.a).toBe(true);
    store.markUnread('a');
    expect(useShellStore.getState().unread).toBe(afterFirst); // same reference — no re-render
  });

  it('clearUnread removes the mark, and is a no-op when already clear', () => {
    useShellStore.getState().markUnread('a');
    useShellStore.getState().clearUnread('a');
    expect(useShellStore.getState().unread.a).toBeUndefined();
    const before = useShellStore.getState().unread;
    useShellStore.getState().clearUnread('a');
    expect(useShellStore.getState().unread).toBe(before);
  });
});

describe('removeSession (FR-9, mirrors core dispose_session_shells)', () => {
  it('purges the roster, active-id memory, and unread marks for the session', () => {
    const store = useShellStore.getState();
    store.setShells('s1', [shell('a'), shell('b')]);
    store.setActiveShellId('s1', 'a');
    store.markUnread('a');
    store.markUnread('b');
    // an unrelated session's shell/unread must survive untouched.
    store.setShells('s2', [shell('c', { sessionId: 's2' })]);
    store.markUnread('c');

    store.removeSession('s1');

    const state = useShellStore.getState();
    expect(state.shells.s1).toBeUndefined();
    expect(state.activeShellId.s1).toBeUndefined();
    expect(state.unread.a).toBeUndefined();
    expect(state.unread.b).toBeUndefined();
    expect(state.shells.s2.map((s) => s.id)).toEqual(['c']);
    expect(state.unread.c).toBe(true);
  });

  it('is a no-op for a session with no roster', () => {
    const before = useShellStore.getState().shells;
    useShellStore.getState().removeSession('nope');
    expect(useShellStore.getState().shells).toBe(before);
  });
});

describe('renameRequest', () => {
  it('sets then clears (palette "Shell: rename" hand-off)', () => {
    useShellStore.getState().requestRename('a');
    expect(useShellStore.getState().renameRequest).toBe('a');
    useShellStore.getState().clearRenameRequest();
    expect(useShellStore.getState().renameRequest).toBe(null);
  });
});

// code-editor-workspace FR-2: split editor groups in the Code store (mocked api).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  editorOpen: vi.fn(),
  editorSave: vi.fn(),
  editorClose: vi.fn(),
  editorFiles: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

import { bufferKey, getBuffer } from './buffers';
import { groupsOfRoot, initialCodeState, useCodeStore } from './codeStore';
import { file, PROJECT_ROOT } from './code.testutil';

const RK = 'project:p1';
const ok = <T>(data: T) => ({ ok: true as const, data });
const store = () => useCodeStore.getState();
const groups = () => groupsOfRoot(store(), RK);
const strips = () => groups().groups.map((g) => [g.paths, g.active]);
const range = { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 6 };

beforeEach(() => {
  useCodeStore.setState(initialCodeState());
  Object.values(api).forEach((m) => m.mockReset());
  api.editorClose.mockResolvedValue(ok(null));
  api.editorOpen.mockImplementation(async (r: { path: string }) => ok(file(r.path)));
  store().setRoot(PROJECT_ROOT);
});

describe('groups', () => {
  it('a root starts as one group that follows openFile', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts');
    expect(strips()).toEqual([[['a.ts', 'b.ts'], 'b.ts']]);
    expect(store().tabsByRootKey[RK].active).toBe('b.ts');
  });

  it('splitEditor opens the active file in a second group, sharing one tab record', async () => {
    await store().openFile('a.ts');
    store().splitEditor();
    expect(strips()).toEqual([
      [['a.ts'], 'a.ts'],
      [['a.ts'], 'a.ts'],
    ]);
    expect(groups().focused).toBe(1);
    expect(store().tabsByRootKey[RK].tabs).toHaveLength(1);
  });

  it('openFile targets the focused group; side opens in the other one (creating it)', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts', { side: true });
    expect(strips()).toEqual([
      [['a.ts'], 'a.ts'],
      [['b.ts'], 'b.ts'],
    ]);
    await store().openFile('c.ts');
    expect(strips()[1]).toEqual([['b.ts', 'c.ts'], 'c.ts']);
    store().focusGroup(0);
    expect(store().tabsByRootKey[RK].active).toBe('a.ts');
    await store().openFile('c.ts', { side: true });
    expect(groups().focused).toBe(1);
  });

  it('activate prefers the focused group and otherwise focuses the group that shows the path', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts', { side: true });
    store().activate('a.ts');
    expect(groups().focused).toBe(0);
    store().activate('b.ts', 1);
    expect(groups().focused).toBe(1);
  });

  it('closing a tab open in both groups closes only that group, keeping the buffer', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts');
    store().splitEditor();
    await store().closeInGroup(RK, 0, 'b.ts');
    expect(strips()).toEqual([
      [['a.ts'], 'a.ts'],
      [['b.ts'], 'b.ts'],
    ]);
    expect(getBuffer(bufferKey(RK, 'b.ts'))).toBeDefined();
    expect(api.editorClose).not.toHaveBeenCalled();
  });

  it("closing a group's last tab removes the group; an orphaned path closes its record", async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts', { side: true });
    await store().closeInGroup(RK, 1, 'b.ts');
    expect(strips()).toEqual([[['a.ts'], 'a.ts']]);
    expect(store().tabsByRootKey[RK].tabs.map((t) => t.path)).toEqual(['a.ts']);
    expect(api.editorClose).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'b.ts' });
  });

  it('closeTab (after the dirty prompt) drops the path from every group', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts', { side: true });
    await store().closeTab(RK, 'b.ts');
    expect(strips()).toEqual([[['a.ts'], 'a.ts']]);
  });

  it('view state is kept per (group, path)', async () => {
    await store().openFile('a.ts');
    store().splitEditor();
    store().saveViewState(RK, 'a.ts', { left: true });
    store().saveViewState(RK, 'a.ts', { right: true }, 1);
    expect(store().viewStateOf(RK, 'a.ts')).toEqual({ left: true });
    expect(store().viewStateOf(RK, 'a.ts', 1)).toEqual({ right: true });
  });
});

describe('revealRange', () => {
  it('opens the file in the focused group and queues a selection for that group', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts', { side: true });
    await store().revealRange('c.ts', range);
    expect(strips()[1]).toEqual([['b.ts', 'c.ts'], 'c.ts']);
    expect(store().selectRequest).toEqual({ rootKey: RK, path: 'c.ts', groupId: 1, range });
    store().consumeSelect();
    expect(store().selectRequest).toBeNull();
  });

  it('does not queue a selection when the open fails', async () => {
    api.editorOpen.mockResolvedValue({ ok: false, error: { code: 'EDITOR_FILE_NOT_FOUND', message: 'gone' } });
    await store().revealRange('z.ts', range);
    expect(store().selectRequest).toBeNull();
  });
});

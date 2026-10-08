// code-editor FR-2/4/5/6/11/12 and §7: the Code store against a mocked api.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_MAX_TABS } from '../../../contract/code-editor';

const api = vi.hoisted(() => ({
  editorOpen: vi.fn(),
  editorSave: vi.fn(),
  editorClose: vi.fn(),
  editorFiles: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

import { attachModel, bufferKey, bufferText, getBuffer, type BufferModel } from './buffers';
import { allDirtyTabs, initialCodeState, useCodeStore } from './codeStore';
import { file, PROJECT_ROOT, SESSION_ROOT } from './code.testutil';

const RK = 'project:p1';
const ok = <T>(data: T) => ({ ok: true as const, data });
const err = (code: string, detail?: unknown) => ({ ok: false as const, error: { code, message: code, detail } });
const store = () => useCodeStore.getState();
const tabs = (rk = RK) => store().tabsByRootKey[rk]?.tabs ?? [];
const tabOf = (p: string, rk = RK) => tabs(rk).find((t) => t.path === p)!;

/** A fake Monaco model: what the user typed lives here. */
function fakeModel(text: string): BufferModel & { text: string; undoable: boolean | null } {
  return {
    text,
    undoable: null,
    getText() {
      return this.text;
    },
    setText(t, undoable) {
      this.text = t;
      this.undoable = undoable;
    },
    dispose: vi.fn(),
  };
}
function type(path: string, text: string, rk = RK) {
  const m = fakeModel(text);
  attachModel(bufferKey(rk, path), m);
  store().setDirty(rk, path, true);
  return m;
}

beforeEach(() => {
  useCodeStore.setState(initialCodeState());
  Object.values(api).forEach((m) => m.mockReset());
  api.editorClose.mockResolvedValue(ok(null));
  api.editorFiles.mockResolvedValue(ok({ rootLabel: 'orbit', branch: 'main', paths: ['a.ts', 'src/b.ts'], truncated: false, changes: {} }));
  api.editorOpen.mockImplementation(async (r: { path: string }) => ok(file(r.path)));
  store().setRoot(PROJECT_ROOT);
});

describe('root + files (FR-3/FR-4/FR-5)', () => {
  it('setRoot loads editor_files for that root and keeps the result per root', async () => {
    await store().refreshFiles();
    expect(api.editorFiles).toHaveBeenCalledWith({ root: PROJECT_ROOT });
    expect(store().filesByRootKey[RK]).toMatchObject({ loading: false, error: null, data: { rootLabel: 'orbit' } });
  });

  it('keeps an editor_files failure inline for Retry (§7)', async () => {
    api.editorFiles.mockResolvedValueOnce(err('PROJECT_NOT_FOUND'));
    await store().refreshFiles();
    expect(store().filesByRootKey[RK]).toMatchObject({ loading: false, error: { code: 'PROJECT_NOT_FOUND' } });
  });

  it('switching root keeps each root\'s tabs apart and restores them (flow 2)', async () => {
    await store().openFile('a.ts');
    store().setRoot(SESSION_ROOT);
    expect(store().tabsByRootKey['session:s1']).toBeUndefined();
    await store().openFile('x.ts');
    store().setRoot(PROJECT_ROOT);
    expect(tabs().map((t) => t.path)).toEqual(['a.ts']);
    expect(tabs('session:s1').map((t) => t.path)).toEqual(['x.ts']);
  });

  it('toggles a folder per root', () => {
    store().toggleDir('src');
    expect(store().expandedByRootKey[RK]).toEqual(['src']);
    store().toggleDir('src');
    expect(store().expandedByRootKey[RK]).toEqual([]);
  });
});

describe('openFile (FR-6/FR-8)', () => {
  it('opens a file into an active tab and a buffer, and reveals it in the tree', async () => {
    const res = await store().openFile('src/lib/a.ts');
    expect(res.ok).toBe(true);
    expect(api.editorOpen).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'src/lib/a.ts' });
    expect(store().tabsByRootKey[RK].active).toBe('src/lib/a.ts');
    expect(bufferText(bufferKey(RK, 'src/lib/a.ts'))).toBe('hello\n');
    expect(store().expandedByRootKey[RK]).toEqual(['src', 'src/lib']);
    expect(store().recentByRootKey[RK]).toEqual(['src/lib/a.ts']);
  });

  it('re-opening an open tab only focuses it (no second read)', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts');
    api.editorOpen.mockClear();
    await store().openFile('a.ts');
    expect(api.editorOpen).not.toHaveBeenCalled();
    expect(store().tabsByRootKey[RK].active).toBe('a.ts');
  });

  it('a binary or too-large file leaves no tab and an inline row hint (§7)', async () => {
    api.editorOpen.mockResolvedValueOnce(err('EDITOR_BINARY'));
    const res = await store().openFile('x.png');
    expect(res.ok).toBe(false);
    expect(tabs()).toHaveLength(0);
    expect(store().rowHintByRootKey[RK]).toMatchObject({ path: 'x.png', code: 'EDITOR_BINARY' });
  });

  it('carries the read-only flag of a file over 2 MiB', async () => {
    api.editorOpen.mockResolvedValueOnce(ok(file('big.log', { readOnly: true, readOnlyReason: 'too-large' })));
    await store().openFile('big.log');
    expect(tabOf('big.log')).toMatchObject({ readOnly: true, readOnlyReason: 'too-large' });
  });

  it('the 13th open evicts the LRU clean tab, stops its watch and drops its buffer', async () => {
    for (let i = 0; i < EDITOR_MAX_TABS; i++) await store().openFile(`f${i}.ts`);
    await store().openFile('new.ts');
    expect(tabs()).toHaveLength(EDITOR_MAX_TABS);
    expect(api.editorClose).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'f0.ts' });
    expect(getBuffer(bufferKey(RK, 'f0.ts'))).toBeUndefined();
  });

  it('refuses the 13th open when every tab is dirty, with a hint, and stops the new watch', async () => {
    for (let i = 0; i < EDITOR_MAX_TABS; i++) {
      await store().openFile(`f${i}.ts`);
      store().setDirty(RK, `f${i}.ts`, true);
    }
    const res = await store().openFile('new.ts');
    expect(res.ok).toBe(false);
    expect(tabs()).toHaveLength(EDITOR_MAX_TABS);
    expect(store().noticeByRootKey[RK]).toMatch(/unsaved/i);
    expect(api.editorClose).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'new.ts' });
  });

  it('closeTab drops the buffer and stops the watch', async () => {
    await store().openFile('a.ts');
    await store().closeTab(RK, 'a.ts');
    expect(tabs()).toHaveLength(0);
    expect(getBuffer(bufferKey(RK, 'a.ts'))).toBeUndefined();
    expect(api.editorClose).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'a.ts' });
  });
});

describe('save (FR-11)', () => {
  it('sends LF text with the base version, line ending and bom, then marks it clean and refreshes the tree', async () => {
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { lineEnding: 'crlf', bom: true })));
    await store().openFile('a.ts');
    type('a.ts', 'edited\n');
    api.editorSave.mockResolvedValueOnce(ok({ version: 'v2' }));
    api.editorFiles.mockClear();
    const res = await store().save(RK, 'a.ts');
    expect(res.ok).toBe(true);
    expect(api.editorSave).toHaveBeenCalledWith({ root: PROJECT_ROOT, path: 'a.ts', text: 'edited\n', baseVersion: 'v1', lineEnding: 'crlf', bom: true });
    expect(tabOf('a.ts')).toMatchObject({ version: 'v2', dirty: false });
    expect(getBuffer(bufferKey(RK, 'a.ts'))!.baseline).toBe('edited\n');
    expect(api.editorFiles).toHaveBeenCalled();
  });

  it('EDITOR_STALE never overwrites: it raises the Changed-on-disk bar', async () => {
    await store().openFile('a.ts');
    type('a.ts', 'mine\n');
    api.editorSave.mockResolvedValueOnce(err('EDITOR_STALE', { version: 'v9' }));
    const res = await store().save(RK, 'a.ts');
    expect(res.ok).toBe(false);
    expect(tabOf('a.ts')).toMatchObject({ conflict: { version: 'v9' }, dirty: true, version: 'v1' });
  });

  it('does not save a read-only tab', async () => {
    api.editorOpen.mockResolvedValueOnce(ok(file('big.log', { readOnly: true })));
    await store().openFile('big.log');
    await store().save(RK, 'big.log');
    expect(api.editorSave).not.toHaveBeenCalled();
  });

  it('a save over a deleted file clears the deleted mark (⌘S recreates it)', async () => {
    await store().openFile('a.ts');
    await store().applyEvent({ type: 'editor.deleted', root: PROJECT_ROOT, path: 'a.ts' });
    expect(tabOf('a.ts').deleted).toBe(true);
    api.editorSave.mockResolvedValueOnce(ok({ version: 'v3' }));
    await store().save(RK, 'a.ts');
    expect(tabOf('a.ts')).toMatchObject({ deleted: false, version: 'v3' });
  });

  it('saveAll saves every dirty tab across roots and reports whether all landed', async () => {
    await store().openFile('a.ts');
    type('a.ts', 'A\n');
    store().setRoot(SESSION_ROOT);
    await store().openFile('x.ts');
    type('x.ts', 'X\n', 'session:s1');
    expect(allDirtyTabs(store()).map((d) => d.path)).toEqual(['a.ts', 'x.ts']);
    api.editorSave.mockResolvedValueOnce(ok({ version: 'v2' })).mockResolvedValueOnce(err('EDITOR_WRITE_FAILED'));
    expect(await store().saveAll()).toBe(false);
    expect(allDirtyTabs(store()).map((d) => d.path)).toEqual(['x.ts']);
  });
});

describe('applyEvent (FR-12)', () => {
  it('reloads a clean buffer in place, without touching the undo stack', async () => {
    await store().openFile('a.ts');
    const m = fakeModel('hello\n');
    attachModel(bufferKey(RK, 'a.ts'), m);
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { text: 'agent\n', version: 'v2' })));
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v2' });
    expect(m.text).toBe('agent\n');
    expect(m.undoable).toBe(false);
    expect(tabOf('a.ts')).toMatchObject({ version: 'v2', dirty: false, conflict: null });
  });

  it('ignores the echo of its own version', async () => {
    await store().openFile('a.ts');
    api.editorOpen.mockClear();
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v1' });
    expect(api.editorOpen).not.toHaveBeenCalled();
  });

  it('shows the bar on a dirty buffer; Keep mine rebases onto the disk version', async () => {
    await store().openFile('a.ts');
    type('a.ts', 'mine\n');
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v2' });
    expect(tabOf('a.ts').conflict).toEqual({ version: 'v2' });
    store().keepMine(RK, 'a.ts');
    expect(tabOf('a.ts')).toMatchObject({ version: 'v2', conflict: null, dirty: true });
  });

  it('Reload discards mine (recoverable through undo)', async () => {
    await store().openFile('a.ts');
    const m = type('a.ts', 'mine\n');
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v2' });
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { text: 'agent\n', version: 'v2' })));
    await store().reload(RK, 'a.ts');
    expect(m.text).toBe('agent\n');
    expect(m.undoable).toBe(true);
    expect(tabOf('a.ts')).toMatchObject({ version: 'v2', conflict: null, dirty: false });
  });

  it('marks a deleted file and ignores events for paths that are not open', async () => {
    await store().openFile('a.ts');
    await store().applyEvent({ type: 'editor.deleted', root: PROJECT_ROOT, path: 'a.ts' });
    await store().applyEvent({ type: 'editor.deleted', root: SESSION_ROOT, path: 'a.ts' });
    expect(tabOf('a.ts').deleted).toBe(true);
    expect(store().tabsByRootKey['session:s1']).toBeUndefined();
  });
});

describe('dropRoot (§7)', () => {
  it('closes every tab of a removed root, stops the watches and forgets its state', async () => {
    store().setRoot(SESSION_ROOT);
    await store().openFile('x.ts');
    await store().refreshFiles();
    store().dropRoot('session:s1');
    expect(store().tabsByRootKey['session:s1']).toBeUndefined();
    expect(store().filesByRootKey['session:s1']).toBeUndefined();
    expect(getBuffer(bufferKey('session:s1', 'x.ts'))).toBeUndefined();
    expect(api.editorClose).toHaveBeenCalledWith({ root: SESSION_ROOT, path: 'x.ts' });
    expect(store().root).toBeNull();
  });
});

describe('view state (FR-2)', () => {
  it('keeps each tab\'s view state', async () => {
    await store().openFile('a.ts');
    store().saveViewState(RK, 'a.ts', { cursor: 3 });
    expect(tabOf('a.ts').viewState).toEqual({ cursor: 3 });
  });
});

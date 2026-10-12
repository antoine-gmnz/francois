// code-editor-agents — the Code store's agent-aware half: the remembered target per
// root (FR-5), Review per tab (FR-10), the flash on a reload of a touched file
// (FR-8), the lock on ⌘S (FR-18), and opening a file at a line (FR-15).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  editorOpen: vi.fn(),
  editorSave: vi.fn(),
  editorClose: vi.fn(),
  editorFiles: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

const touch = vi.hoisted(() => ({
  touchedBlocks: vi.fn((): string[] => []),
  noteFlashLine: vi.fn(),
  isLocked: vi.fn(() => false),
}));
vi.mock('./agent-touch', () => touch);

import { attachModel, bufferKey, type BufferModel } from './buffers';
import { initialCodeState, useCodeStore } from './codeStore';
import { file, PROJECT_ROOT, SESSION_ROOT } from './code.testutil';

const RK = 'project:p1';
const KEY = bufferKey(RK, 'a.ts');
const ok = <T>(data: T) => ({ ok: true as const, data });
const store = () => useCodeStore.getState();
const tabOf = (p: string, rk = RK) => store().tabsByRootKey[rk]!.tabs.find((t) => t.path === p)!;

function model(text: string): BufferModel & { text: string } {
  return {
    text,
    getText() {
      return this.text;
    },
    setText(t) {
      this.text = t;
    },
    dispose: vi.fn(),
  };
}

beforeEach(async () => {
  useCodeStore.setState(initialCodeState());
  Object.values(api).forEach((m) => m.mockReset());
  Object.values(touch).forEach((m) => m.mockReset());
  touch.touchedBlocks.mockReturnValue([]);
  touch.isLocked.mockReturnValue(false);
  api.editorClose.mockResolvedValue(ok(null));
  api.editorFiles.mockResolvedValue(ok({ rootLabel: 'orbit', branch: 'main', paths: ['a.ts'], truncated: false, changes: {}, rootDir: 'C:/r' }));
  api.editorOpen.mockImplementation(async (r: { path: string }) => ok(file(r.path)));
  store().setRoot(PROJECT_ROOT);
  await store().refreshFiles();
});

describe('remembered target (FR-5)', () => {
  it('keeps the last pick per root dir', () => {
    store().rememberTarget('C:/r', 's1');
    store().rememberTarget('/other', 's2');
    expect(store().lastTargetByRootDir).toEqual({ 'C:/r': 's1', '/other': 's2' });
  });
});

describe('Review toggle (FR-10)', () => {
  it('is per tab', async () => {
    await store().openFile('a.ts');
    await store().openFile('b.ts');
    store().setReview(RK, 'a.ts', true);
    expect(tabOf('a.ts').review).toBe(true);
    expect(tabOf('b.ts').review).toBe(false);
  });
});

describe('absPath', () => {
  it('joins the root dir and the relative path', () => {
    expect(store().absPath(RK, 'src/a.ts')).toBe('C:/r/src/a.ts');
    expect(store().absPath('project:none', 'a.ts')).toBeNull();
  });
});

describe('flash on reload of a touched file (FR-8)', () => {
  it('flashes the changed lines of a clean reload and records the first one against the blocks', async () => {
    await store().openFile('a.ts');
    attachModel(KEY, model('hello\n'));
    touch.touchedBlocks.mockReturnValue(['b1']);
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { text: 'hello\nagent\nmore\n', version: 'v2' })));
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v2' });
    expect(touch.touchedBlocks).toHaveBeenCalledWith('C:/r/a.ts');
    expect(store().flashByKey[KEY]?.lines).toEqual([2, 3]);
    expect(touch.noteFlashLine).toHaveBeenCalledWith(['b1'], 2);
  });

  it('flashes after Reload on the bar too', async () => {
    await store().openFile('a.ts');
    attachModel(KEY, model('mine\n'));
    touch.touchedBlocks.mockReturnValue(['b1']);
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { text: 'agent\n', version: 'v2' })));
    await store().reload(RK, 'a.ts');
    expect(store().flashByKey[KEY]?.lines).toEqual([1]);
  });

  it('does not flash a reload no session touched', async () => {
    await store().openFile('a.ts');
    attachModel(KEY, model('hello\n'));
    api.editorOpen.mockResolvedValueOnce(ok(file('a.ts', { text: 'bash edit\n', version: 'v2' })));
    await store().applyEvent({ type: 'editor.changed', root: PROJECT_ROOT, path: 'a.ts', version: 'v2' });
    expect(store().flashByKey[KEY]).toBeUndefined();
    expect(touch.noteFlashLine).not.toHaveBeenCalled();
  });
});

describe('save while locked (FR-18)', () => {
  it('does not write a locked buffer', async () => {
    await store().openFile('a.ts');
    attachModel(KEY, model('mine\n'));
    store().setDirty(RK, 'a.ts', true);
    touch.isLocked.mockReturnValue(true);
    await store().save(RK, 'a.ts');
    expect(api.editorSave).not.toHaveBeenCalled();
    expect(touch.isLocked).toHaveBeenCalledWith('C:/r/a.ts');
  });
});

describe('openAt (FR-15)', () => {
  it('switches to the root, opens the file relative to it and asks the editor to reveal the line', async () => {
    api.editorFiles.mockResolvedValue(ok({ rootLabel: 's', branch: null, paths: [], truncated: false, changes: {}, rootDir: '/w' }));
    const res = await store().openAt(SESSION_ROOT, '/w/src/auth.ts', 40, '/w');
    expect(res.ok).toBe(true);
    expect(store().root).toEqual(SESSION_ROOT);
    expect(api.editorOpen).toHaveBeenLastCalledWith({ root: SESSION_ROOT, path: 'src/auth.ts' });
    expect(store().revealByKey[bufferKey('session:s1', 'src/auth.ts')]).toBe(40);
  });

  it("shows v1's notice for a missing file", async () => {
    api.editorOpen.mockResolvedValueOnce({ ok: false, error: { code: 'EDITOR_FILE_NOT_FOUND', message: 'gone' } });
    const res = await store().openAt(SESSION_ROOT, '/w/gone.ts', 1, '/w');
    expect(res.ok).toBe(false);
    expect(store().noticeByRootKey['session:s1']).toBe('File not found: gone.ts');
  });
});

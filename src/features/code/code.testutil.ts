// Shared fixtures for the code feature's tests.

import type { EditorFile, EditorRoot } from '../../../contract/code-editor';
import type { CodeTab } from './code-tabs';

export const PROJECT_ROOT: EditorRoot = { kind: 'project', projectId: 'p1' };
export const SESSION_ROOT: EditorRoot = { kind: 'session', sessionId: 's1' };

export function tab(path: string, patch: Partial<CodeTab> = {}): CodeTab {
  return {
    path,
    version: 'v1',
    dirty: false,
    viewState: null,
    lineEnding: 'lf',
    bom: false,
    trailingNewline: true,
    readOnly: false,
    headText: null,
    conflict: null,
    deleted: false,
    ...patch,
  };
}

export function file(path: string, patch: Partial<EditorFile> = {}): EditorFile {
  return {
    root: PROJECT_ROOT,
    path,
    text: 'hello\n',
    version: 'v1',
    lineEnding: 'lf',
    bom: false,
    trailingNewline: true,
    readOnly: false,
    headText: null,
    ...patch,
  };
}

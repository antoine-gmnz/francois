// code-editor-workspace FR-2/FR-11: the mounted Monaco instance of each editor group
// (by EditorGroup.id), so quick open's `@` can read the focused group's symbols. Kept
// outside the store, like the models.

import type * as Monaco from 'monaco-editor';
import type { MonacoModule } from './monaco-loader';

export interface GroupEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
  module: MonacoModule;
}

const editors = new Map<number, GroupEditor>();

export function setGroupEditor(groupId: number, entry: GroupEditor | null): void {
  if (entry) editors.set(groupId, entry);
  else editors.delete(groupId);
}

export function groupEditor(groupId: number): GroupEditor | undefined {
  return editors.get(groupId);
}

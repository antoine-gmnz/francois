// contract/open-in-vscode.ts — open-in-vscode feature contract.
// Binding per PIPELINE.md: francois:session:<verb> -> invoke('session_<verb>') -> Promise<Result<T>>.
// Added ErrorCode members ('EDITOR_NOT_FOUND', 'EDITOR_LAUNCH_FAILED') live in contract/common.ts.

import type { Result, SessionId } from './common';

/** The VS Code family editors Francois can detect and launch (FR-1). */
export type EditorId = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf';

export interface EditorInfo {
  id: EditorId;
  label: string; // 'VS Code' | 'VS Code Insiders' | 'Cursor' | 'Windsurf'
  path: string; // absolute path of the resolved launcher (FR-2); shown only in the item's title
}

// ---------- francois:session:editorList ----------
export interface EditorListData {
  editors: EditorInfo[]; // FR-1 probe order == menu order; [] = none installed, NOT an error
}
// invoke('session_editor_list'): Promise<Result<EditorListData>>
// no request payload — app-scoped (FR-1).
// errors: 'INTERNAL' only.
export type EditorListResponse = Result<EditorListData>;

// ---------- francois:session:openInEditor ----------
export interface OpenInEditorRequest {
  sessionId: SessionId;
  editorId: EditorId;
}
// invoke('session_open_in_editor', req): Promise<Result<null>>
// FR-4/5/6: target resolution follows the filesystem (is_wsl_unc_path(session.cwd)), never the
// session's ClaudeRuntime. FR-8: spawn is an argv array, not awaited; FR-12: no session mutation,
// no event, no disk write.
// errors: 'SESSION_NOT_FOUND' | 'EDITOR_NOT_FOUND' | 'EDITOR_LAUNCH_FAILED' | 'INTERNAL'
export type OpenInEditorResponse = Result<null>;

// ---------- pure frontend helper (owned here, unit-tested) ----------

/** FR-1 order + the id->label table, so core and frontend cannot drift. */
export const EDITOR_ORDER: readonly EditorId[] = ['vscode', 'vscode-insiders', 'cursor', 'windsurf'];

export const EDITOR_LABELS: Record<EditorId, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
};

/** FR-9 item copy: `Open in VS Code`, `Open in Cursor`, … */
export function editorMenuLabel(editor: EditorInfo): string {
  return `Open in ${editor.label}`;
}

// code-editor-agents — frontend-only shapes (no IPC).
// The wire amendments live in the files that own each domain:
//   contract/common.ts       — FileTouchKind + SessionEvent 'file.touched'
//   contract/code-editor.ts  — EditorFilesData.rootDir
import type { SessionId } from './common';

export type ContextChipKind = 'selection' | 'comment' | 'revert';

export interface ContextChip {
  id: string; // uuid v4
  kind: ContextChipKind;
  path: string; // absolute, normalised (FR-2)
  startLine: number; // 1-based
  endLine: number; // inclusive; === startLine for a comment
  snippet?: string; // selection only, LF, ≤ CONTEXT_CHIP_MAX_LINES lines
  totalLines?: number; // set when snippet was cut (FR-7)
  language?: string; // Monaco language id, for the fence
  note?: string; // comment (required) / revert (prefilled) / selection (optional)
  createdAt: number;
}

export const CONTEXT_CHIPS_PER_SESSION = 20;
export const CONTEXT_CHIP_MAX_LINES = 400;
export const AGENT_FLASH_MS = 1500;

export type ChipTarget = { sessionId: SessionId };

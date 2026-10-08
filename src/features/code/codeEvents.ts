// code-editor FR-12: ONE app-wide subscription to francois://editor/event, started
// from CodeBackground. App-wide because a watched file's tab outlives the Code tab
// being on screen (FR-2). Idempotent, like initShellEvents.

import { onEditorEvent } from '../../lib/api';
import { useCodeStore } from './codeStore';

let started = false;

export function initCodeEvents(): void {
  if (started) return;
  started = true;
  void onEditorEvent((e) => void useCodeStore.getState().applyEvent(e));
}

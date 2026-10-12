// code-editor FR-12: ONE app-wide subscription to francois://editor/event, started
// from CodeBackground. App-wide because a watched file's tab outlives the Code tab
// being on screen (FR-2). Idempotent, like initShellEvents.
//
// code-editor-lsp FR-16: francois://lsp/event is subscribed the same way, once. The
// store takes every event; diagnostics are also handed to the Monaco bridge (once it
// is loaded) so a file with a model gets them as markers (FR-12).

import type { LspEvent } from '../../../contract/code-editor-lsp';
import { onEditorEvent, onLspEvent } from '../../lib/api';
import { useCodeStore } from './codeStore';
import { useLspStore } from './lspStore';

type DiagnosticsEvent = Extract<LspEvent, { type: 'lsp.diagnostics' }>;

let started = false;
let lspStarted = false;
let diagnosticsSink: ((e: DiagnosticsEvent) => void) | null = null;

export function initCodeEvents(): void {
  if (started) return;
  started = true;
  void onEditorEvent((e) => void useCodeStore.getState().applyEvent(e));
}

/** The bridge's hook for diagnostics, installed once Monaco loaded. */
export function setLspDiagnosticsSink(fn: ((e: DiagnosticsEvent) => void) | null): void {
  diagnosticsSink = fn;
}

export function handleLspEvent(e: LspEvent): void {
  useLspStore.getState().applyEvent(e);
  if (e.type === 'lsp.diagnostics') diagnosticsSink?.(e);
}

export function initLspEvents(): void {
  if (lspStarted) return;
  lspStarted = true;
  void onLspEvent(handleLspEvent).catch(() => {});
}

// code-editor-agents FR-5 — handing a chip to its session: silently when exactly one
// live session runs on the editor's root, else through the picker; then the 4s
// confirmation. A chip only lands above a composer — nothing is sent from here.

import { useCallback, useState } from 'react';
import type { ContextChip } from '../../../contract/code-editor-agents';
import type { SessionId } from '../../../contract/common';
import { addChip, CHIP_LIMIT_MESSAGE } from '../../lib/context-chips';
import { useStore } from '../../lib/store';
import type { AddedNotice } from './AgentBits';
import { useCodeStore } from './codeStore';
import { resolveTarget, type TargetResolution } from './send-target';

type PickResolution = Extract<TargetResolution, { kind: 'pick' }>;

export interface Anchor {
  top: number;
  left: number;
}

export interface PickerState {
  resolution: PickResolution;
  chip: ContextChip;
  at: Anchor;
}

export interface ChipSender {
  send: (chip: ContextChip, at: Anchor) => void;
  picker: PickerState | null;
  pick: (sessionId: SessionId) => void;
  cancelPicker: () => void;
  notice: AddedNotice | null;
  clearNotice: () => void;
}

const nameOf = (id: SessionId) => useStore.getState().sessions.find((s) => s.id === id)?.name ?? 'session';

/** Adds a chip to its target (FR-5): silently when there is exactly one, else through the picker. */
export function useChipSender(rootDir: string | null): ChipSender {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [notice, setNotice] = useState<AddedNotice | null>(null);

  const deliver = (sessionId: SessionId, chip: ContextChip) => {
    const res = addChip(sessionId, chip);
    setNotice(res.ok ? { text: `Added to ${nameOf(sessionId)}`, sessionId } : { text: CHIP_LIMIT_MESSAGE });
  };

  const send = (chip: ContextChip, at: Anchor) => {
    if (!rootDir) return;
    const remembered = useCodeStore.getState().lastTargetByRootDir[rootDir];
    const r = resolveTarget(useStore.getState().sessions, rootDir, remembered);
    if (r.kind === 'none') setNotice({ text: 'No session to send to' });
    else if (r.kind === 'direct') deliver(r.sessionId, chip);
    else setPicker({ resolution: r, chip, at });
  };

  const pick = (sessionId: SessionId) => {
    if (!picker || !rootDir) return;
    useCodeStore.getState().rememberTarget(rootDir, sessionId);
    deliver(sessionId, picker.chip);
    setPicker(null);
  };

  return { send, picker, pick, cancelPicker: () => setPicker(null), notice, clearNotice: useCallback(() => setNotice(null), []) };
}

/** The comment box's right-hand label: who ⏎ will hand the note to. */
export function useTargetLabel(rootDir: string | null): string {
  const sessions = useStore((s) => s.sessions);
  if (!rootDir) return '';
  const r = resolveTarget(sessions, rootDir);
  if (r.kind === 'none') return 'No session to send to';
  if (r.kind === 'direct') return sessions.find((s) => s.id === r.sessionId)?.name ?? '';
  return '⏎ picks a session';
}

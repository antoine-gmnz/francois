// code-editor-agents FR-4 / FR-5 — the two editor pieces that hand content to a
// session: the ⌘L target picker and the gutter comment box rendered into a Monaco
// view zone. Target resolution + the confirmation live in useChipSender.ts.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionId } from '../../../contract/common';
import { basename } from '../../lib/path';
import { useStore } from '../../lib/store';
import { StatusDot } from '../../ui/StatusDot';
import { pickerItems } from './send-target';
import type { PickerState } from './useChipSender';
import './code.css';

/** FR-5: same-root sessions first, then every other live session with its root. ↑/↓/⏎/Esc. */
export function TargetPicker({ state, onPick, onCancel }: { state: PickerState; onPick: (id: SessionId) => void; onCancel: () => void }): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const items = pickerItems(state.resolution);
  const [cursor, setCursor] = useState(() => Math.max(0, items.indexOf(state.resolution.highlight)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // the FR-14 fence: no app single-key shortcut, no Monaco
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[cursor]) onPick(items[cursor]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const row = (id: SessionId, other: boolean) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return null;
    const on = items[cursor] === id;
    return (
      <div
        key={id}
        role="option"
        aria-selected={on}
        className={on ? 'code-picker__row code-picker__row--on' : 'code-picker__row'}
        onMouseEnter={() => setCursor(items.indexOf(id))}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(id)}
      >
        <StatusDot color={s.status === 'running' ? 'var(--state-running)' : 'var(--state-idle)'} size={7} />
        <span className="code-picker__name">{s.name}</span>
        {s.worktree?.branch && <span className="code-picker__branch">{s.worktree.branch}</span>}
        {other && <span className="code-picker__root">{basename(s.cwd)}</span>}
      </div>
    );
  };

  const { sameRoot, others } = state.resolution;
  return (
    <div
      ref={ref}
      className="code-picker"
      role="listbox"
      aria-label="Send to session"
      tabIndex={-1}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCancel();
      }}
      // eslint-disable-next-line no-restricted-syntax -- anchored to the selection / comment box, computed at runtime
      style={{ top: state.at.top, left: state.at.left }}
    >
      {sameRoot.length > 0 && <div className="code-picker__group">On this root</div>}
      {sameRoot.map((id) => row(id, false))}
      {others.length > 0 && <div className="code-picker__group">Other sessions</div>}
      {others.map((id) => row(id, true))}
    </div>
  );
}

/**
 * FR-4: the inline comment box under a line (a Monaco view zone — the caller
 * portals this into the zone's node). Keys are handled natively on the textarea
 * and stopped there: the zone lives inside Monaco's DOM, so its keybindings and
 * the app's single-key shortcuts would otherwise see every keystroke.
 */
export function CommentBox({ target, onSubmit, onCancel }: { target: string; onSubmit: (note: string) => void; onCancel: () => void }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = useRef(onSubmit);
  const cancel = useRef(onCancel);
  submit.current = onSubmit;
  cancel.current = onCancel;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.current();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const note = el.value.trim();
        if (note) submit.current(note); // FR-4: an empty note is refused
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="code-comment">
      <textarea ref={ref} className="code-comment__input" rows={2} placeholder="Comment for a session…" aria-label="Comment for a session" />
      <div className="code-comment__foot">
        <span className="code-comment__hint">⏎ add · Esc cancel</span>
        <span className="code-comment__target">{target}</span>
      </div>
    </div>
  );
}

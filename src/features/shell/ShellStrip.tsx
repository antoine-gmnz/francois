// multiple-shells §8, redrawn for Graphite & Signal (Figma "Shell tabs"
// 136:6067): the SHELL tab's sub-tab strip — one tab per shell (terminal glyph,
// name, unread dot, ✕ on hover), a `+`, and the active shell's cwd on the right.
// The design shows the strip at every shell count, so FR-11's "hidden at ≤1"
// rule is superseded: the cwd it carries used to live in the footer.

import { useEffect, useRef, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import type { ShellId, ShellInfo } from '../../../contract/shell-terminal';
import { Icon } from '../../ui/Icon';
import { atShellCap, truncateShellLabel } from './shell';
import { closeShell, newShell, renameShell } from './shellActions';
import { useShellStore, useShellUnread } from './shellStore';
import './shell.css';

export interface ShellStripProps {
  sessionId: SessionId;
  shells: ShellInfo[];
  activeShellId: ShellId | null;
  /** The active shell's working directory, already abbreviated for display. */
  cwdLabel?: string | null;
}

export default function ShellStrip({ sessionId, shells, activeShellId, cwdLabel }: ShellStripProps) {
  const atCap = atShellCap(shells);

  return (
    <div className="shell-strip scz" role="tablist" aria-label="Shells">
      {shells.map((s) => (
        <ShellChip
          key={s.id}
          sessionId={sessionId}
          shell={s}
          active={s.id === activeShellId}
          onSelect={() => {
            useShellStore.getState().setActiveShellId(sessionId, s.id);
            useShellStore.getState().clearUnread(s.id);
          }}
          onClose={() => void closeShell(sessionId, s.id)}
        />
      ))}
      <button
        type="button"
        className="shell-strip__new"
        title={atCap ? '6 shells maximum' : 'New shell  ⌘T'}
        aria-label="New shell"
        disabled={atCap}
        onClick={() => void newShell(sessionId)}
      >
        <Icon name="plus" size={13} />
      </button>
      <span className="shell-strip__spacer" />
      {cwdLabel && (
        <span className="shell-strip__cwd truncate" title={cwdLabel}>
          {cwdLabel}
        </span>
      )}
    </div>
  );
}

function ShellChip({
  sessionId,
  shell,
  active,
  onSelect,
  onClose,
}: {
  sessionId: SessionId;
  shell: ShellInfo;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const unread = useShellUnread(shell.id);
  const renameRequest = useShellStore((s) => s.renameRequest);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shell.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // command-palette "Shell: rename" hand-off (FR-22, shellStore.ts's `renameRequest`).
  useEffect(() => {
    if (renameRequest === shell.id) {
      setDraft(shell.name);
      setEditing(true);
      useShellStore.getState().clearRenameRequest();
    }
  }, [renameRequest, shell.id, shell.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    setDraft(shell.name);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    void renameShell(sessionId, shell.id, draft);
  };
  const cancel = () => setEditing(false);

  return (
    <span
      onClick={editing ? undefined : onSelect}
      onDoubleClick={editing ? undefined : startRename}
      title={editing ? undefined : shell.alive ? shell.name : `${shell.name} — exited`}
      role="tab"
      aria-selected={active}
      className={['shell-chip', active && 'shell-chip--active', !shell.alive && 'shell-chip--exited'].filter(Boolean).join(' ')}
    >
      <Icon name="terminal" size={13} className="shell-chip__icon" />
      {editing ? (
        <input
          ref={inputRef}
          className="shell-chip-rename-input"
          value={draft}
          autoFocus
          // §8: sized to the chip's current label, min ~72px — a runtime value
          // (draft length), so it stays inline per the CSS contract.
          style={{ width: `${Math.max(draft.length, 8)}ch` }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={cancel}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
        />
      ) : (
        <span className="shell-chip-name truncate">{truncateShellLabel(shell.name)}</span>
      )}
      {!editing && unread && <span className="shell-chip-unread" />}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close shell"
        className="shell-chip-close"
      >
        <Icon name="x" size={11} />
      </span>
    </span>
  );
}

// multiple-shells §8: the SHELL tab's sub-tab strip — one chip per shell
// (process dot, name, unread dot, ✕) plus a `+`. Hidden entirely at 0 (see
// ShellTabView's own empty-state strip) or 1 shell (FR-11) — a single-shell
// session must stay pixel-identical to today's SHELL tab.

import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { SessionId } from '../../../contract/common';
import type { ShellId, ShellInfo } from '../../../contract/shell-terminal';
import { StatusDot } from '../../ui/StatusDot';
import { atShellCap, stripVisible, truncateShellLabel } from './shell';
import { closeShell, newShell, renameShell } from './shellActions';
import { useShellStore, useShellUnread } from './shellStore';
import './shell.css';

export interface ShellStripProps {
  sessionId: SessionId;
  shells: ShellInfo[];
  activeShellId: ShellId | null;
  /** Renders even at ≤1 shell, holding only the `+` (FR-23 empty state). */
  forceVisible?: boolean;
}

export default function ShellStrip({ sessionId, shells, activeShellId, forceVisible = false }: ShellStripProps) {
  if (!forceVisible && !stripVisible(shells)) return null;
  const atCap = atShellCap(shells);

  return (
    <div className="shell-strip scz">
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
      <span
        className={atCap ? 'shell-chip shell-chip--plus shell-chip--disabled' : 'shell-chip shell-chip--plus'}
        title={atCap ? '6 shells maximum' : 'New shell  ⌘T'}
        onClick={atCap ? undefined : () => void newShell(sessionId)}
      >
        <Plus size={12} />
      </span>
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
      title={editing ? undefined : shell.name}
      className={active ? 'shell-chip shell-chip--active' : 'shell-chip'}
    >
      <StatusDot color={shell.alive ? 'var(--success)' : 'var(--error)'} size={6} />
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
        <X size={11} />
      </span>
    </span>
  );
}

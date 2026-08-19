// session-permission-mode (specs/session-permission-mode.md §8) — the session-row
// mode badge and its popover. The badge keeps `session-row__mode`'s existing
// geometry (app.css) but is now always rendered and clickable (FR-9); the
// popover lists the four PERMISSION_MODE_OPTIONS rows, marks the current one,
// and — while the session is busy — appends the "applies to the next turn"
// line (FR-10, FR-11). Picking a mode never writes the store itself: the
// session.meta event that comes back over the wire is the single update path
// (FR-12); the Result is used only to surface a failure inline (FR-13).

import { useRef, useState } from 'react';
import type { PermissionMode, SessionMeta } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { sessionSwitchPermissionMode } from '../../lib/api';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { permissionBadgeClass, permissionModeOption, permissionModeRunningNote } from './permission-mode';
import './permission-mode.css';

export function PermissionModeBadge({ session }: { session: SessionMeta }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { error, setError, schedule } = useTimedError();

  // FR-10: closes on outside click and on Escape; never opened by a bare-letter
  // global key (that global-key wiring simply doesn't exist here).
  useDismiss(rootRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const option = permissionModeOption(session.permissionMode);
  const runningNote = permissionModeRunningNote(session.status);

  async function pick(mode: PermissionMode) {
    if (pending) return;
    setPending(true);
    setError(null);
    const res = await sessionSwitchPermissionMode(session.id, mode);
    setPending(false);
    if (res.ok) {
      // FR-3/FR-10: even a no-op pick closes the popover on success.
      setOpen(false);
    } else {
      // FR-13: stays open, error inline, badge unchanged (no optimistic update).
      setError(res.error.message);
      schedule(() => setError(null), 4000);
    }
  }

  return (
    <div ref={rootRef} className="perm-mode">
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`permission mode: ${option.label}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={permissionBadgeClass(session.permissionMode)}
      >
        {option.short}
      </span>

      {open && (
        <div role="listbox" aria-label="permission mode" className="perm-mode__popover">
          {PERMISSION_MODE_OPTIONS.map((opt) => {
            const current = opt.mode === session.permissionMode;
            return (
              <div
                key={opt.mode}
                role="option"
                aria-selected={current}
                onClick={() => void pick(opt.mode)}
                className={
                  'perm-mode__option' +
                  (current ? ' perm-mode__option--current' : '') +
                  (opt.danger ? ' perm-mode__option--danger' : '')
                }
              >
                <span className="perm-mode__option-marker">{current ? '●' : ''}</span>
                <span className="perm-mode__option-body">
                  <span className="perm-mode__option-label">{opt.label}</span>
                  <span className="perm-mode__option-hint">{opt.hint}</span>
                </span>
              </div>
            );
          })}
          {runningNote && <div className="perm-mode__note">{runningNote}</div>}
          {error && <div className="perm-mode__error">{error}</div>}
        </div>
      )}
    </div>
  );
}

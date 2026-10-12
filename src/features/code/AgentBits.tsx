// code-editor-agents — the small agent-aware pieces of the Code tab (design brief):
// the session chip on tabs and explorer rows (FR-9), the lock strip (FR-16/17),
// and the transient "Added to <session> · Open" confirmation (FR-5).

import { useEffect } from 'react';
import { Lock } from 'lucide-react';
import type { SessionId } from '../../../contract/common';
import { formatRelativeTime } from '../../../contract/fleet-board';
import { Button } from '../../ui/Button';
import { selectChip, unlock } from './agent-touch';
import type { TouchView } from './touch-view';
import { openSession } from './open-in-code';
import './code.css';

const edited = (at: number) => {
  const rel = formatRelativeTime(at);
  return rel === 'now' ? 'edited just now' : `edited ${rel} ago`;
};

/** FR-9: the last toucher of a changed file, beside the git letter (never replacing it). */
export function SessionChip({ view, abs, changed }: { view: TouchView; abs: string | null; changed: boolean }): JSX.Element | null {
  if (!abs || !changed) return null;
  const chip = selectChip(view.touch, abs, view.statusOf);
  const name = chip ? view.session(chip.sessionId)?.name : undefined;
  if (!chip || !name) return null;
  return (
    <span className={chip.live ? 'code-agent-chip code-agent-chip--live' : 'code-agent-chip'} title={`${name} · ${edited(chip.at)}`}>
      {name}
    </span>
  );
}

/** FR-16/FR-17: read-only while a session's turn is editing this file. */
export function LockStrip({ view, abs, holders }: { view: TouchView; abs: string; holders: SessionId[] }): JSX.Element | null {
  if (holders.length === 0) return null;
  const name = view.session(holders[0])?.name ?? 'A session';
  return (
    <div className="code-lock">
      <Lock size={14} className="code-lock__icon" aria-hidden />
      <span className="code-agent-chip code-agent-chip--live">{name}</span>
      <span className="code-lock__text">{name} is working on this file · read-only until its turn ends</span>
      {holders.length > 1 && <span className="code-lock__more">+{holders.length - 1}</span>}
      <Button variant="secondary" size="sm" className="code-lock__unlock" onClick={() => unlock(abs, holders)}>
        Unlock anyway
      </Button>
    </div>
  );
}

export interface AddedNotice {
  text: string;
  /** The session the chip landed in — renders **Open**. */
  sessionId?: SessionId;
}

const NOTICE_MS = 4000;

/** FR-5: "Added to <session> · Open", 4s, bottom-right of the editor area. */
export function AddedPill({ notice, onDone }: { notice: AddedNotice | null; onDone: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDone, NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, onDone]);
  if (!notice) return null;
  const { sessionId } = notice;
  return (
    <div className="code-added" role="status">
      <span>{notice.text}</span>
      {sessionId && (
        <>
          <span className="code-added__sep">·</span>
          <button
            type="button"
            className="code-added__open"
            onClick={() => {
              onDone();
              openSession(sessionId);
            }}
          >
            Open
          </button>
        </>
      )}
    </div>
  );
}

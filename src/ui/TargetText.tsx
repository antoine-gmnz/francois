import { useState, type MouseEvent, type ReactNode } from 'react';
import { editorOpenTarget } from '../lib/api';
import { isOpenModifier, targetParts } from '../lib/open-target';

export function TargetLink({ target, children }: { target: string; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!isOpenModifier(e)) return;
    e.stopPropagation();
    const sessionId = e.currentTarget.closest('[data-session-id]')?.getAttribute('data-session-id') ?? undefined;
    void editorOpenTarget({ target, sessionId })
      .then(res => setError(res.ok ? null : res.error.message))
      .catch(err => setError(`Could not open target: ${String(err)}`));
  };
  return <><a className="md-link" href="#" title={`${target} · Ctrl/Cmd + click to open`} onClick={open}>{children}</a>{error && <span role="status"> — {error}</span>}</>;
}

export function TargetText({ text }: { text: string }) {
  return <>{targetParts(text).map((part, i) => part.target
    ? <TargetLink key={i} target={part.target}>{part.text}</TargetLink>
    : <span key={i}>{part.text}</span>)}</>;
}

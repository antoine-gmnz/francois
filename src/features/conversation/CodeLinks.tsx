// code-editor-agents FR-14 / FR-15 — the transcript's jumps into the Code tab: a
// tool row's path (when its block has a `file.touched`) and an inline-code
// `path` / `path:line` span (when the path is in the session root's file list).
// Click opens the Code tab at the file and line; ⌘-click (Ctrl-click off macOS)
// opens it in the external editor instead.

import { useContext, type MouseEvent, type ReactNode } from 'react';
import { useBlockTarget } from '../code/agent-touch';
import { parseCodeRef } from '../code/code-ref';
import { openInCode, openInEditorExternally, useSessionHasFile } from '../code/open-in-code';
import { TranscriptSession } from './transcript-session';

function CodeLink({ sessionId, path, line, title, children }: { sessionId: string; path: string; line: number; title: string; children: ReactNode }): JSX.Element {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation(); // never also toggle an expandable tool row
    if (e.metaKey || e.ctrlKey) void openInEditorExternally(sessionId, path, line);
    else void openInCode(sessionId, path, line);
  };
  return (
    <a className="code-link" href="#" title={title} onClick={onClick}>
      {children}
    </a>
  );
}

/** FR-14: a tool row's target column — a link once the core said this block touched a file. */
export function ToolTarget({ blockId, children }: { blockId: string; children: ReactNode }): JSX.Element {
  const target = useBlockTarget(blockId);
  if (!target) return <>{children}</>;
  return (
    <CodeLink sessionId={target.sessionId} path={target.path} line={target.line} title={`Open ${target.path} in Code · ⌘-click: external editor`}>
      {children}
    </CodeLink>
  );
}

/** FR-14: an inline-code span, linked when it names a file in the session root. `fallback` otherwise. */
export function CodeSpanLink({ text, fallback }: { text: string; fallback: ReactNode }): JSX.Element {
  const sessionId = useContext(TranscriptSession);
  const ref = parseCodeRef(text);
  const known = useSessionHasFile(ref ? sessionId : null, ref?.path ?? null);
  if (!sessionId || !ref || !known) return <>{fallback}</>;
  return (
    <CodeLink sessionId={sessionId} path={ref.path} line={ref.line ?? 1} title={`Open ${ref.path} in Code · ⌘-click: external editor`}>
      {text}
    </CodeLink>
  );
}

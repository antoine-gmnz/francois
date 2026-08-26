// command-inspect §8 (design turn 16a "Unfolds in place"): the four bands of an
// open step record — header, `$` line (or generic input JSON), output strip,
// output body + fold footer. Pure DOM assembly; every decision it renders is
// computed by ./step-detail (unit-tested there). Mounted by ToolRow, which owns
// the fetch/open/loading state — this component only ever sees a resolved
// `StepDetail`.

import { useRef, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import type { StepDetail, StepOutput } from '../../../contract/command-inspect';
import { shellEnsure, shellWrite } from '../../lib/api';
import {
  stepHeaderGroups,
  stepOutputFooter,
  stepOutputTotals,
  type StepHeaderSegment,
  visibleStepOutputLines,
} from './step-detail';

export interface StepDetailPanelProps {
  detail: StepDetail;
  sessionId: SessionId;
  /** command-inspect FR-16: switches THIS pane's main tab to SHELL — see ConversationView. */
  onOpenShell?: () => void;
}

export default function StepDetailPanel({ detail, sessionId, onOpenShell }: StepDetailPanelProps) {
  return (
    <div className="step-detail">
      <Header detail={detail} />
      {detail.body.kind === 'command' ? (
        <CommandLine command={detail.body.command.command} sessionId={sessionId} onOpenShell={onOpenShell} />
      ) : (
        <div className="step-detail__json">{detail.body.inputJson}</div>
      )}
      <OutputBand output={detail.body.output} />
    </div>
  );
}

/**
 * design brief §8: the tool segment carries its own tint, the rest of the
 * left group is plain, and the right group (clock · duration · outcome) is
 * pushed to the far edge — outcome only ever renders when the step did NOT
 * succeed cleanly (stepHeaderGroups), so its tint always reads as attention.
 */
function Header({ detail }: { detail: StepDetail }) {
  const { left, right } = stepHeaderGroups(detail);
  return (
    <div className="step-detail__header">
      <HeaderSegments segments={left} />
      <span className="step-detail__header-right">
        <HeaderSegments segments={right} />
      </span>
    </div>
  );
}

function HeaderSegments({ segments }: { segments: StepHeaderSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span key={`${seg.tone}:${seg.text}`}>
          {i > 0 && <span className="step-detail__header-sep"> · </span>}
          <span className={`step-detail__header-seg step-detail__header-seg--${seg.tone}`}>{seg.text}</span>
        </span>
      ))}
    </>
  );
}

function CommandLine({ command, sessionId, onOpenShell }: { command: string; sessionId: SessionId; onOpenShell?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied — the command is on screen to copy by hand */
    }
  }

  // FR-16: switches THIS pane's main tab to SHELL (onOpenShell, threaded down
  // from ConversationView — command-inspect round-2 fix: a global
  // setFocusedPane('main')/setMainTab('shell') always targeted pane 0), ensures
  // a shell for the session, and writes the command with NO trailing newline —
  // never executes it (edge case table: shellEnsure's own error, e.g. the
  // shell cap, surfaces here rather than a toast).
  async function openInShell() {
    setShellError(null);
    onOpenShell?.();
    const ensured = await shellEnsure({ owner: { kind: 'session', sessionId } });
    if (!ensured.ok) {
      setShellError(ensured.error.message);
      return;
    }
    const written = await shellWrite(ensured.data.shellId, command);
    if (!written.ok) setShellError(written.error.message);
  }

  return (
    <div className="step-detail__cmd">
      <span className="step-detail__cmd-line">
        <span className="step-detail__prompt">$</span> {command}
      </span>
      <span className="step-detail__actions">
        <button type="button" className="step-detail__action" onClick={() => void copy()}>
          {copied ? 'copied' : 'copy'}
        </button>
        <button type="button" className="step-detail__action" onClick={() => void openInShell()}>
          shell ↗
        </button>
      </span>
      {shellError && <div className="step-detail__error">{shellError}</div>}
    </div>
  );
}

function OutputBand({ output }: { output: StepOutput }) {
  const [showAll, setShowAll] = useState(false);
  if (output.text === '') return null;
  const footer = stepOutputFooter(output, showAll);
  const lines = visibleStepOutputLines(output, showAll);
  return (
    <div className="step-detail__output">
      <div className="step-detail__output-strip">{stepOutputTotals(output)}</div>
      <pre className="step-detail__output-body">{lines.join('\n')}</pre>
      {footer && (
        <div className="step-detail__fold">
          {footer.kind === 'folded' ? `${footer.count} earlier lines folded` : `${footer.count} lines dropped at capture`}
          {footer.showAllLink && (
            <button type="button" className="step-detail__show-all" onClick={() => setShowAll(true)}>
              show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

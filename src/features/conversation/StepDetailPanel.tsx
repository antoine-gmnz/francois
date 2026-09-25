// command-inspect §8 (design turn 16a "Unfolds in place"): the four bands of an
// open step record — header, `$` line (or generic input JSON), output strip,
// output body + fold footer. Pure DOM assembly; every decision it renders is
// computed by ./step-detail (unit-tested there). Mounted by ToolRow, which owns
// the fetch/open/loading state — this component only ever sees a resolved
// `StepDetail`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import type { SessionId } from '../../../contract/common';
import type { StepDetail, StepOutput } from '../../../contract/command-inspect';
import { shellEnsure, shellWrite } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { parseAnsi } from './ansi';
import {
  stepHeaderGroups,
  stepOutputFooter,
  stepOutputTotals,
  type StepHeaderSegment,
  visibleStepOutputLines,
} from './step-detail';
import {
  claudeEditDiffLines,
  highlightJson,
  highlightShell,
  isUnifiedDiff,
  tokenizeUnifiedDiff,
  type DiffLine,
  type SyntaxToken,
} from './step-syntax';

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
        <CommandLine
          command={detail.body.command.command}
          prompt={detail.tool.toLowerCase() === 'powershell' ? 'PS>' : '$'}
          sessionId={sessionId}
          onOpenShell={onOpenShell}
        />
      ) : (
        <GenericInput tool={detail.tool} inputJson={detail.body.inputJson} />
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

/** Lossless coloured tokens (./step-syntax) — index-keyed, a line is positional. */
function SyntaxText({ tokens }: { tokens: SyntaxToken[] }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.tone === 'plain' ? t.text : (
          <span key={i} className={`syn syn--${t.tone}`}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}

function JsonInput({ json }: { json: string }) {
  const tokens = useMemo(() => highlightJson(json), [json]);
  return (
    <pre className="step-detail__json">
      <SyntaxText tokens={tokens} />
    </pre>
  );
}

/**
 * A Claude Code Edit/MultiEdit/Write step's input carries old/new fragments,
 * not the JSON a reader wants to inspect — render the SAME diff colouring the
 * output band uses for a Codex Edit (step-syntax's claudeEditDiffLines turns
 * the fragment into the identical DiffLine shape), and fall back to the
 * pretty-printed JSON when the input doesn't parse or isn't one of those tools.
 */
function GenericInput({ tool, inputJson }: { tool: string; inputJson: string }) {
  const diffLines = useMemo(() => claudeEditDiffLines(tool, inputJson), [tool, inputJson]);
  if (diffLines !== null) return <DiffText lines={diffLines} />;
  return <JsonInput json={inputJson} />;
}

function CommandLine({
  command,
  prompt,
  sessionId,
  onOpenShell,
}: {
  command: string;
  prompt: string;
  sessionId: SessionId;
  onOpenShell?: () => void;
}) {
  const tokens = useMemo(() => highlightShell(command), [command]);
  const [copied, setCopied] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useMounted();

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      if (!mounted.current) return;
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 1200);
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
    if (!mounted.current) return;
    if (!ensured.ok) {
      setShellError(ensured.error.message);
      return;
    }
    const written = await shellWrite(ensured.data.shellId, command);
    if (!mounted.current) return;
    if (!written.ok) setShellError(written.error.message);
  }

  return (
    <div className="step-detail__cmd">
      <span className="step-detail__prompt" aria-hidden="true">
        {prompt}
      </span>
      <pre className="step-detail__cmd-line">
        <SyntaxText tokens={tokens} />
      </pre>
      <span className="step-detail__actions">
        <button
          type="button"
          className={`step-detail__action${copied ? ' step-detail__action--done' : ''}`}
          onClick={() => void copy()}
          title="Copy command"
          aria-label={copied ? 'Copied' : 'Copy command'}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button type="button" className="step-detail__action" onClick={() => void openInShell()} title="Paste into shell (not run)" aria-label="Paste into shell">
          <SquareTerminal size={13} />
        </button>
      </span>
      {shellError && <div className="step-detail__error">{shellError}</div>}
    </div>
  );
}

/**
 * Captured output, rendered the way a terminal would render it: the escape
 * sequences in the bytes become colour instead of `←[0;32m` litter, and the
 * indentation survives because the band is `pre` with an 8-column tab stop
 * (conversation.css). The parse is memoised on the text — `show all` swaps a
 * 15-line slice for a whole 64 KB capture, and re-parsing that on an unrelated
 * re-render is the kind of cost the transcript's hot path exists to avoid.
 *
 * `style` is per CLAUDE.md's runtime-value exception: 256-colour and truecolour
 * spans carry a colour computed from the bytes, which no class can name.
 */
function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre className="step-detail__output-body">
      {spans.map((s, i) => (
        <span key={i} className={s.className || undefined} style={s.color || s.background ? { color: s.color, background: s.background } : undefined}>
          {s.text}
        </span>
      ))}
    </pre>
  );
}

/**
 * A Codex `Edit` step's output is a real unified diff (`git diff`-shaped) —
 * ./step-syntax's isUnifiedDiff sniffs the WHOLE capture (the tail-biased
 * `show all` slice can drop the `--- `/`+++ ` headers off the top), then this
 * colours each visible line the same tokens the DIFF tab uses, so a Codex edit
 * and a `git diff` in the DIFF tab never disagree about what red and green mean.
 */
function DiffText({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="step-detail__output-body step-detail__diff">
      {lines.map((l, i) => (
        <div key={i} className={`step-detail__diff-line step-detail__diff-line--${l.kind}`}>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function OutputDiff({ text }: { text: string }) {
  const lines = useMemo(() => tokenizeUnifiedDiff(text), [text]);
  return <DiffText lines={lines} />;
}

function OutputBand({ output }: { output: StepOutput }) {
  const [showAll, setShowAll] = useState(false);
  if (output.text === '') return null;
  const footer = stepOutputFooter(output, showAll);
  const lines = visibleStepOutputLines(output, showAll);
  const isDiff = isUnifiedDiff(output.text);
  return (
    <div className="step-detail__output">
      <div className="step-detail__output-strip">
        <span className="step-detail__label">output</span>
        <span>{stepOutputTotals(output)}</span>
      </div>
      {isDiff ? <OutputDiff text={lines.join('\n')} /> : <AnsiText text={lines.join('\n')} />}
      {footer && (
        <div className="step-detail__fold">
          <span>{footer.kind === 'folded' ? `${footer.count} earlier lines folded` : `${footer.count} lines dropped at capture`}</span>
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

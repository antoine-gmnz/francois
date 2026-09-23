// One rendered ConversationBlock (conversation-view §8). Extracted verbatim from
// ConversationView so the agent-tab body renders a subagent's transcript with the
// SAME vocabulary — glyphs, colors, markdown, tool-card layout — instead of
// growing a second renderer that would drift from this one.
//
// design 9a: the SESSION transcript no longer renders through `Block` — it
// groups blocks into turns (Turn.tsx) and draws its own gutter and header. The
// per-block BODIES are exported from here and shared by both, so a turn and an
// agent trail keep saying the same thing the same way; only the container
// around them differs.

import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  formatElapsed,
  toolBody,
  type ConversationBlock,
  type NoticeConversationBlock,
  type SubagentConversationBlock,
  type ToolConversationBlock,
  type UserConversationBlock,
} from '../../../contract/conversation-view';
import type { AssistantConversationBlock } from '../../../contract/conversation-view';
import type { RuntimeToolCall, SessionId } from '../../../contract/common';
import type { StepDetail } from '../../../contract/command-inspect';
import CommandBlock from '../commands/CommandCard';
import { classifyCohorteTool } from '../cohorte/tool-row';
import { useCohorteStore } from '../../lib/cohorteStore';
import { toneVar } from '../../lib/tone';
import { stepDetail as fetchStepDetail } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useMounted } from '../../lib/hooks/useMounted';
import { usePresence } from '../../lib/hooks/usePresence';
import { useDelayedFlag } from '../../lib/hooks/useDelayedFlag';
import { runtimeToolElapsedMs, runtimeToolStatusLabel } from './runtime-tool-blocks';
import Markdown from './MarkdownView';
import PermissionCard from '../permissions/PermissionCard';
import QuestionCard from '../questions/QuestionCard';
import StepDetailPanel from './StepDetailPanel';
import { Caret, LOADER_DELAY_MS, LoaderCaret } from '../../ui/Loaders';
import { toolResultChips } from './transcript-turns';
import './conversation.css';

// transcript-perf FR-2: every prop these receive is referentially stable
// across a render that does not change it (Turn.tsx's `turn`/Turn items come
// from a useMemo keyed on state.blocks), so the default shallow React.memo
// comparison is enough to bail a render that has nothing new to draw.

function BlockImpl({
  b: block,
  sessionId,
  onOpenShell,
}: {
  b: ConversationBlock;
  sessionId: string;
  /** command-inspect FR-16: threaded to a tool row's StepDetailPanel — see ConversationView. */
  onOpenShell?: () => void;
}) {
  // interactive-commands: command cards (and notice one-liners) have their own renderer (§8)
  if (block.kind === 'command') {
    return <CommandBlock b={block} sessionId={sessionId} />;
  }
  // session-questions: interactive question cards (spec §8)
  if (block.kind === 'question') {
    return <QuestionCard b={block} sessionId={sessionId} />;
  }
  // permission-guardrails: approval cards for gated tool calls (spec §8)
  if (block.kind === 'permission') {
    return <PermissionCard b={block} sessionId={sessionId} />;
  }
  // pi-transcript-events FR-5: a neutral notice — unsupported/thinking
  // content, compaction/retry progress, protocol-level diagnostics.
  if (block.kind === 'notice') {
    return <NoticeRow b={block} />;
  }
  if (block.kind === 'user') {
    // design 7a: the prompt is an accent `›` line in the terminal's own type,
    // not a bordered card. The glyph carries the who — a "YOU" label above a
    // card was the sans-era way of saying the same thing twice.
    return (
      <div className="block-row block-user">
        <span className="block-glyph block-user__arrow">›</span>
        <div className="block-content">
          <UserBody b={block} />
        </div>
      </div>
    );
  }

  // Assistant replies arrive as Markdown source — render it formatted (own
  // container, so the shared pre-wrap wrapper below never touches it). The
  // streaming caret trails the rendered content. The body tone rides a class,
  // not a color: the contract's literal is a dark-palette hex, and an inline
  // color would beat every light-theme rule (see lib/tone.ts).
  if (block.kind === 'assistant') {
    return (
      <div className="block-row">
        <span className="block-glyph" style={{ color: toneVar(block.glyphColor) }}>
          {block.glyph}
        </span>
        <div className="block-content">
          <AssistantBody b={block} />
        </div>
      </div>
    );
  }

  if (block.kind === 'subagent') {
    return <SubagentBanner b={block} />;
  }

  // design 9a: a lone tool call is a bare row — the same object a session turn
  // renders, without the rail. An agent trail is a flat list, so a rail per
  // block would draw a 1px stub beside every row and join nothing.
  return <ToolRow b={block} sessionId={sessionId} onOpenShell={onOpenShell} />;
}

const Block = memo(BlockImpl);
export default Block;

// ---------- shared bodies (design 9a: one vocabulary, two containers) ----------

function UserBodyImpl({ b }: { b: UserConversationBlock }) {
  // transcript-perf FR-21: the `.block-user__queued` badge is gone — a queued
  // prompt no longer becomes a transcript block at all (see ./pending-queue
  // and the composer's own pending strip), so `queued` is no longer a field
  // this body could read.
  return (
    <>
      <div className="block-user__body">{b.text}</div>
      {/* pi-transcript-events FR-7: attachments resolved against the existing
          ingest/asset scopes; a missing one renders a named placeholder
          rather than dropping the reference silently (design brief). */}
      {b.attachments && b.attachments.length > 0 && (
        <div className="block-user__attachments">
          {b.attachments.map((att) => (
            <span
              key={att.id}
              className={'block-user__attachment' + (att.state === 'missing' ? ' block-user__attachment--missing' : '')}
            >
              {att.name}
              {att.state === 'missing' && ' — Attachment unavailable'}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
export const UserBody = memo(UserBodyImpl);

function AssistantBodyImpl({ b }: { b: AssistantConversationBlock }) {
  return (
    <>
      <Markdown text={b.text} streaming={b.isStreaming} />
      {b.isStreaming && <Caret />}
      {/* pi-transcript-events FR-9: the word a non-'complete' outcome states —
          crash/stop finalizes partial output as interrupted, never as
          succeeded. 'interrupted'/'error' already read as their own label. */}
      {b.outcome && b.outcome !== 'complete' && (
        <span className={`block-outcome block-outcome--${b.outcome}`}>{b.outcome}</span>
      )}
    </>
  );
}
export const AssistantBody = memo(AssistantBodyImpl);

/** pi-transcript-events FR-5: a neutral notice row — never streamed, tone as
 *  well as colour (design brief). Reuses the transcript's own typography;
 *  no new border/shadow treatment. */
function NoticeRowImpl({ b }: { b: NoticeConversationBlock }) {
  return (
    <div className={`block-notice block-notice--${b.tone}`}>
      <span className="block-notice__text">{b.text}</span>
    </div>
  );
}
export const NoticeRow = memo(NoticeRowImpl);

/**
 * design-refresh FR-7: dispatch renders as a purple-tinted banner, not a bare
 * glyph row — bold agent name, soft bg from --hue-purple. It stays a banner
 * rather than a rail row under 9a: a dispatch hands the work to someone else,
 * which is a different kind of event from a tool the reply ran itself.
 */
function SubagentBannerImpl({ b }: { b: SubagentConversationBlock }) {
  return (
    <div className="block-subagent">
      <span className="block-glyph" style={{ color: toneVar(b.glyphColor) }}>
        {b.glyph}
      </span>
      <div className="block-content block-body" style={{ color: toneVar(b.bodyColor) }}>
        Dispatched subagent <span className="block-subagent__name">{b.agentName}</span>
        {/* The model the dispatch named — shown only when it differs from the
            session default, i.e. only when the dispatch named one at all. */}
        {b.agentModel && <span className="block-subagent__model">{b.agentModel}</span>}
        {b.meta && <span className="block-meta"> · {b.meta}</span>}
      </div>
    </div>
  );
}
export const SubagentBanner = memo(SubagentBannerImpl);

/**
 * design 9a: one tool call, as a four-column row — glyph · tool name · target ·
 * result. The result stopped being a ` · 14 failed` tail on the end of a
 * sentence and became chips at the right edge, so a column of calls can be
 * scanned for the one that went wrong without reading any of them.
 *
 * command-inspect (design 16a): a row with `hasDetail` also carries a chevron
 * — the ONLY thing that makes it clickable (FR-12). Open/loading/fetched-detail
 * state lives here, local to the row: a settled step is fetched once per mount
 * and never re-fetched (FR-13), and unmounting (session switch, transcript
 * eviction) drops it for free, which is exactly FR-18's "cleared on session
 * switch, never persisted". An agent-tab/workflow trail's lone-row usage never
 * carries `hasDetail` (FR-8) — regardless of `sessionId`, which AgentView and
 * WorkflowView do pass — so the chevron/click path below is never reachable
 * there.
 *
 * pi-transcript-events FR-3/FR-4: a row carrying `execution` (a Pi-produced
 * tool call) is expandable the same way, but needs no fetch — the sanitized
 * input/output preview already rode the block over IPC (§5/§6). Mutually
 * exclusive with `hasDetail` in practice (command-inspect is Claude-only), so
 * `hasDetail` keeps first claim on the fetch path below.
 */
function ToolRowImpl({
  b,
  sessionId,
  onOpenShell,
}: {
  b: ToolConversationBlock;
  sessionId?: SessionId;
  /** command-inspect FR-16: threaded to the mounted StepDetailPanel. */
  onOpenShell?: () => void;
}) {
  // cohorte-integration FR-66: a `cohorte …` Bash call reads as a Cohorte row;
  // a launching call that printed a run id records FR-30's `launched` link.
  const cohorte = useMemo(
    () => classifyCohorteTool(b.tool, b.summary, `${b.meta ?? ''}
${b.execution?.outputText ?? ''}`),
    [b.tool, b.summary, b.meta, b.execution?.outputText],
  );
  const launchedRef = cohorte?.launchedRef ?? null;
  useEffect(() => {
    if (sessionId && launchedRef) useCohorteStore.getState().recordLaunch(sessionId, launchedRef);
  }, [sessionId, launchedRef]);
  const chips = toolResultChips(cohorte?.meta ?? b.meta);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StepDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const mountedRef = useMounted();
  const expandable = b.hasDetail === true || b.execution !== undefined;
  const { present, exiting } = usePresence(open, STEP_DETAIL_EXIT_MS);
  // Gated here (LoaderCaret gets delay={0}) so the record's height-open plays
  // against real content: nothing mounts while a fast fetch is in flight, and
  // each phase — loader, error, record — is keyed so it grows in on its own.
  const showLoader = useDelayedFlag(loading, LOADER_DELAY_MS);
  const phase = detail ? 'detail' : fetchError ? 'error' : showLoader ? 'loading' : null;

  function handleClick() {
    if (!expandable) return;
    if (b.execution !== undefined && !b.hasDetail) {
      // Sanitized input/output already rode the block — toggle in place, no fetch.
      setOpen((o) => !o);
      return;
    }
    if (!sessionId) return;
    const next = !open;
    setOpen(next);
    // FR-13: fetched once per mount, never re-fetched — a settled step is
    // immutable. Runs as an ordinary side effect (not inside the `setOpen`
    // updater, which StrictMode double-invokes) so `fetchStepDetail` fires
    // exactly once per open.
    if (next && detail === null && !loading) {
      setLoading(true);
      setFetchError(null);
      void fetchStepDetail(sessionId, b.blockId).then((res) => {
        if (!mountedRef.current) return;
        setLoading(false);
        if (res.ok) setDetail(res.data);
        else setFetchError(res.error.message);
      });
    }
  }

  // design brief: "Click or Enter/Space expands tool details" — Space's
  // default action (page scroll) is suppressed only when this row is
  // actually the thing about to toggle.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!expandable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <>
      <div
        className={'toolrow' + (b.isStreaming ? ' toolrow--live' : '') + (expandable ? ' toolrow--expandable' : '') + (open ? ' toolrow--open' : '')}
        onClick={expandable ? handleClick : undefined}
        onKeyDown={expandable ? handleKeyDown : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="toolrow__glyph" style={{ color: toneVar(b.glyphColor) }}>
          {b.glyph}
        </span>
        <span className="toolrow__name">{cohorte ? 'Cohorte' : b.tool}</span>
        {/* The full call stays reachable on hover — the target column truncates,
            and a truncated path is exactly when you want the whole one. */}
        <span className="toolrow__target" title={toolBody(b.tool, b.summary)}>
          {cohorte ? cohorte.target : b.summary}
        </span>
        {/* One cell for the whole right edge: the meta chips and, after them,
            the disclosure. They have to share the grid's 4th column — as a 5th
            child the chevron wrapped onto an implicit second row, which both
            put it under the glyph and made an expandable row taller than an
            inert one (design 16a: same height open, closed or inert). */}
        <span className="toolrow__meta">
          <span className="toolrow__chips">
            {b.isStreaming && chips.length === 0 ? (
              <Caret />
            ) : (
              chips.map((c) => (
                <span key={`${c.tone}:${c.text}`} className={`toolrow__chip toolrow__chip--${c.tone}`}>
                  {c.text}
                </span>
              ))
            )}
          </span>
          {expandable && (
            <span className="toolrow__disclosure">
              open <span className="toolrow__chevron">⌄</span>
            </span>
          )}
        </span>
      </div>
      {present && sessionId && b.hasDetail && phase && (
        <div key={phase} className={stepDetailWrapClass(exiting)}>
          <div className="step-detail-wrap__inner">
            {phase === 'loading' && (
              <div className="step-detail__loading">
                <LoaderCaret label="loading" delay={0} />
              </div>
            )}
            {phase === 'error' && <div className="step-detail__error">{fetchError}</div>}
            {detail && <StepDetailPanel detail={detail} sessionId={sessionId} onOpenShell={onOpenShell} />}
          </div>
        </div>
      )}
      {present && b.execution && !b.hasDetail && <RuntimeToolDetail tool={b.execution} exiting={exiting} />}
    </>
  );
}
export const ToolRow = memo(ToolRowImpl);

/** How long a closed record stays mounted to play its exit — keep in step with
 *  `step-detail-close` in conversation.css. */
const STEP_DETAIL_EXIT_MS = 160;

function stepDetailWrapClass(exiting: boolean): string {
  return exiting ? 'step-detail-wrap step-detail-wrap--closing' : 'step-detail-wrap';
}

/**
 * pi-transcript-events FR-3/FR-4/design brief: the sanitized input/output
 * preview for a Pi tool call, unfolded in place — reuses the existing
 * `.step-detail*` typography/geometry (StepDetailPanel) rather than a new
 * treatment. No raw input/output JSON is parsed/executed here — both fields
 * are already bounded, sanitized text (contract/common.ts RuntimeToolCall).
 *
 * FR-4/design brief §Data shown: timing rides the same right-aligned header
 * cell as the status word. The clock only ticks (`useElapsedClock`) while the
 * call is genuinely in flight and unsettled — a completed/failed/cancelled
 * call's duration is fixed, so no interval is scheduled for it.
 */
function RuntimeToolDetailImpl({ tool, exiting = false }: { tool: RuntimeToolCall; exiting?: boolean }) {
  const unsettled = tool.completedAt === undefined;
  const now = useElapsedClock(unsettled);
  const elapsedMs = runtimeToolElapsedMs(tool, now);
  const statusLabel = runtimeToolStatusLabel(tool.status);
  return (
    <div className={stepDetailWrapClass(exiting)}>
      <div className="step-detail-wrap__inner">
        <div className="step-detail">
          <div className="step-detail__header">
            <span className="step-detail__header-seg step-detail__header-seg--tool">{tool.name}</span>
            <span className="step-detail__header-right">
              {elapsedMs !== null && (
                <span className="step-detail__header-seg">{formatElapsed(elapsedMs)}</span>
              )}
              {statusLabel && (
                <>
                  {elapsedMs !== null && <span className="step-detail__header-sep"> · </span>}
                  <span className="step-detail__header-seg">{statusLabel}</span>
                </>
              )}
            </span>
          </div>
          {tool.inputText && (
            <div className="step-detail__json">
              {tool.inputText}
              {tool.inputTruncated && ' …'}
            </div>
          )}
          {tool.outputText && (
            <div className="step-detail__output">
              <div className="step-detail__output-strip">
                <span className="step-detail__label">output</span>
                {tool.outputTruncated && <span>truncated</span>}
              </div>
              <pre className="step-detail__output-body">{tool.outputText}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export const RuntimeToolDetail = memo(RuntimeToolDetailImpl);

/**
 * design 9a: a run of consecutive tool calls hangs off a single vertical rail
 * inside the turn's content column. The rail replaces 7a's hairline-divided
 * card — under the flat treatment a card would be a second surface floating in
 * the turn, where the rail reads as "this is what that paragraph did".
 */
function ToolRailImpl({
  blocks,
  sessionId,
  onOpenShell,
}: {
  blocks: ToolConversationBlock[];
  sessionId: SessionId;
  /** command-inspect FR-16: threaded to every row's StepDetailPanel — see ConversationView. */
  onOpenShell?: () => void;
}) {
  return (
    <div className="toolrail">
      {blocks.map((b) => (
        <ToolRow key={b.blockId} b={b} sessionId={sessionId} onOpenShell={onOpenShell} />
      ))}
    </div>
  );
}
export const ToolRail = memo(ToolRailImpl);

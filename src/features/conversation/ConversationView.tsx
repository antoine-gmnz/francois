import { useMemo, useRef, useState, type ReactNode } from 'react';
import { isBusyStatus } from '../../../contract/fleet-board';
import ComposerPane from './ComposerPane';
import Block from './Block';
import Turn from './Turn';
import { groupTurns, turnIsStreaming, type TranscriptItem } from './transcript-turns';
import { compactBlocks, TRANSCRIPT_TEXT_SELECT_STYLE, windowedBlocks } from './conversation-blocks';
import EarlierBlocksRow from './EarlierBlocksRow';
import JumpToLatestChip from './JumpToLatestChip';
import ResumeFailBanner from './ResumeFailBanner';
import UsageLimitBanner from './UsageLimitBanner';
import { useConversationTranscript } from './useConversationTranscript';
import { hasPendingPermissionBlock } from '../permissions/permission-card';
import { hasPendingQuestionBlock } from '../questions/question-card';
import { useSessionMeta } from '../../lib/hooks/useSessionMeta';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import './conversation.css';
import { dismissWorktreeNotice, isWorktreeNoticeDismissed } from '../sessions/worktree';
import WorktreeNotice from './WorktreeNotice';
import WelcomeBlock from './WelcomeBlock';

// transcript-perf: this component now owns ONLY the transcript's own state
// (the reducer, hydration, the worktree/resume/limit banners) plus the
// derived, memoized `items` it renders. Every bit of state that only ever fed
// the composer moved to ./ComposerPane (FR-1) — a keystroke re-renders that
// subtree alone. Block apply rules (reducer) and the SessionEvent dispatch
// table live in ./conversation-blocks — pure + unit-tested. Hydration/
// subscription plumbing lives in ./useConversationTranscript.

export interface ConversationViewProps {
  sessionId: string;
  /**
   * split-session FR-6: this pane is NOT focused — the composer is replaced by
   * an inert strip reading `click to focus this pane`, so a keystroke can never
   * land in the wrong session. The transcript keeps streaming, unchanged.
   */
  inert?: boolean;
  /** What the inert strip does when clicked: move focus to this pane. */
  onFocusRequest?: () => void;
  /**
   * split-by-4 FR-11: what an inert pane renders in the composer's place. The
   * grid chrome's footer is state-driven (`⌘2 to focus and type`, or *Review
   * diff* · *close pane ✕*), so the pane owns it rather than this view. Absent ⇒
   * the default `click to focus this pane` strip.
   */
  inertFooter?: ReactNode;
}

export default function ConversationView({ sessionId, inert = false, onFocusRequest, inertFooter }: ConversationViewProps) {
  const meta = useSessionMeta(sessionId);
  const {
    state,
    dispatch,
    hydrated,
    hydrationError,
    status,
    errorMessage,
    resumeFailed,
    dismissResumeFailed,
    limitNotice,
    dismissLimitNotice,
    commands,
    isPinned,
    setPinned,
    scrollRef,
    onScroll,
    jumpToLatest,
    earlierRow,
    activateEarlier,
  } = useConversationTranscript(sessionId);

  // design 9a: a streaming turn's header counts its duration up. Gated on the
  // session being busy, so a transcript of finished turns re-renders never —
  // their spans are fixed by the blocks' own timestamps.
  const transcriptClock = useElapsedClock(isBusyStatus(status));

  // session-worktree FR-14: per-session dismissal, persisted in localStorage —
  // once dismissed the banner never returns for this session (component is
  // keyed by sessionId, so this state is naturally fresh per session).
  const [worktreeNoticeDismissed, setWorktreeNoticeDismissed] = useState(() => isWorktreeNoticeDismissed(sessionId));

  // transcript-perf FR-3: run ONLY when state.blocks itself changes — a
  // composer keystroke no longer even reaches this component (FR-1), so the
  // remaining trigger is an actual transcript event, matching what FR-3 asks.
  //
  // FR-2: `prevItemsRef` carries the last render's own `items` back into
  // `groupTurns`, which reuses a settled turn's wrapper object unchanged —
  // so a streamed token only ever produces a NEW `TranscriptTurn` reference
  // for the one turn actually receiving it, and every other `Turn`'s
  // `React.memo` bails on the rest.
  const prevItemsRef = useRef<TranscriptItem[]>([]);
  // transcript-scale FR-11: only the trailing RENDER_WINDOW blocks are ever
  // turned into DOM items — the rest stay held (bounded) but unmounted.
  const items = useMemo(() => {
    const next = groupTurns(compactBlocks(windowedBlocks(state)), prevItemsRef.current);
    prevItemsRef.current = next;
    return next;
  }, [state]);

  // session-questions FR-20 / permission-guardrails FR-23: whether the
  // composer's placeholder should swap. Derived here (not passed as raw
  // `state.blocks`) so ComposerPane only re-renders when one of these
  // booleans actually flips, not on every streamed token.
  const hasPendingQuestion = useMemo(() => hasPendingQuestionBlock(state.blocks), [state.blocks]);
  const hasPendingPermission = useMemo(() => hasPendingPermissionBlock(state.blocks), [state.blocks]);

  return (
    <div className="conv-root">
      {/* session-worktree FR-14: pinned bare-checkout notice, above the transcript
          so it never scrolls away. attach-to-worktree FR-18: suppressed for an
          adopted tree — Francois made no claim about what is in it. */}
      {meta?.worktree && !meta.worktree.adopted && !worktreeNoticeDismissed && (
        <WorktreeNotice
          worktree={meta.worktree}
          onDismiss={() => {
            dismissWorktreeNotice(sessionId);
            setWorktreeNoticeDismissed(true);
          }}
        />
      )}

      {/* resume-fail banner (durable-sessions FR-14) */}
      {resumeFailed && <ResumeFailBanner onDismiss={dismissResumeFailed} />}

      {/* plan usage-limit notice — the session stays live behind it */}
      {limitNotice !== null && <UsageLimitBanner message={limitNotice} onDismiss={dismissLimitNotice} />}

      {/* transcript */}
      <div className="conv-transcript-wrap">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scz conv-scroll"
          // mac-text-selection FR-1: .conv-scroll already sets `user-select: text`;
          // WKWebView needs the -webkit- prefixed form too — see
          // TRANSCRIPT_TEXT_SELECT_STYLE.
          style={TRANSCRIPT_TEXT_SELECT_STYLE}
        >
          {hydrationError ? (
            <Centered>
              <span className="conv-error-text">{hydrationError}</span>
            </Centered>
          ) : hydrated && state.blocks.length === 0 ? (
            // design 7a: the framed welcome block stands in for the transcript
            // until the first turn — see WelcomeBlock for what it states.
            <div className="conv-item">
              <WelcomeBlock sessionId={sessionId} />
            </div>
          ) : (
            // design 9a: the transcript is a list of TURNS. A card (approval,
            // question, command output) still renders at this level — it is the
            // transcript stopping, not a paragraph of a reply.
            <>
              {/* transcript-scale FR-12: the earlier-blocks row, first child of
                  the reading column, above the oldest rendered block. */}
              {earlierRow.visible && (
                <EarlierBlocksRow count={earlierRow.count} onActivate={activateEarlier} inert={inert} />
              )}
              {items.map((item) => (
                <div key={item.kind === 'turn' ? item.turnId : item.block.blockId} className="conv-item">
                  {item.kind === 'turn' ? (
                    // transcript-perf FR-4: the ticking clock reaches only the
                    // turn actually streaming; every settled turn gets a frozen
                    // value `turnSpanMs` never reads, so Turn's memo bails and a
                    // 1s tick re-renders exactly one Turn.
                    <Turn turn={item} model={meta?.model.label} now={turnIsStreaming(item) ? transcriptClock : 0} />
                  ) : (
                    <Block b={item.block} sessionId={sessionId} />
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        {!isPinned && <JumpToLatestChip onClick={jumpToLatest} />}
      </div>

      {/* input bar — split-session FR-6: an unfocused pane renders the SAME
          composer, not a substitute strip. transcript-perf FR-1: every bit of
          composer-owned state (input, popup, history walk, attachments, the
          pending-queue strip) now lives inside ComposerPane, so a keystroke
          never reaches this component's own render. */}
      <ComposerPane
        sessionId={sessionId}
        inert={inert}
        onFocusRequest={onFocusRequest}
        inertFooter={inertFooter}
        status={status}
        errorMessage={errorMessage}
        hasPendingQuestion={hasPendingQuestion}
        hasPendingPermission={hasPendingPermission}
        commands={commands}
        meta={meta}
        dispatch={dispatch}
        setPinned={setPinned}
      />
    </div>
  );
}

/** The hydration-failure notice — the only thing left that stands alone. */
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="conv-item conv-centered">{children}</div>;
}

// The per-block renderer moved to ./Block.tsx — agent-tab renders a subagent's
// transcript with the same component, so there is exactly one of it.

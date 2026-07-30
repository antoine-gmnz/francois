import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlashCommandInfo } from '../../../contract/common';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { sessionClear, sessionInterrupt, sessionSend } from '../../lib/api';
import Block, { ToolGroup } from './Block';
import Composer from './Composer';
import { compactBlocks, groupToolRuns, isClearCommand, TRANSCRIPT_TEXT_SELECT_STYLE } from './conversation-blocks';
import JumpToLatestChip from './JumpToLatestChip';
import ResumeFailBanner from './ResumeFailBanner';
import { useConversationTranscript } from './useConversationTranscript';
import { hasPendingPermissionBlock } from '../permissions/permission-card';
import { composerPlaceholder, hasPendingQuestionBlock } from '../questions/question-card';
import {
  completionText,
  filterCommands,
  moveSelection,
  nextDismissed,
  popupKeyAction,
  popupVisible,
  refreshSelection,
  slashToken,
} from '../commands/slash-menu';
import { useStore } from '../../lib/store';
import './conversation.css';
import { dismissWorktreeNotice, isWorktreeNoticeDismissed } from '../sessions/worktree';
import WorktreeNotice from './WorktreeNotice';

// Block apply rules (reducer) and the SessionEvent dispatch table live in
// ./conversation-blocks — pure + unit-tested. Hydration/subscription plumbing
// lives in ./useConversationTranscript.

export default function ConversationView({ sessionId }: { sessionId: string }) {
  const meta = useStore((s) => s.sessions.find((session) => session.id === sessionId) ?? null);
  const {
    state,
    dispatch,
    hydrated,
    hydrationError,
    status,
    errorMessage,
    resumeFailed,
    dismissResumeFailed,
    commands,
    isPinned,
    setPinned,
    scrollRef,
    onScroll,
    jumpToLatest,
  } = useConversationTranscript(sessionId);

  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  // session-worktree FR-14: per-session dismissal, persisted in localStorage —
  // once dismissed the banner never returns for this session (component is
  // keyed by sessionId, so this state is naturally fresh per session).
  const [worktreeNoticeDismissed, setWorktreeNoticeDismissed] = useState(() => isWorktreeNoticeDismissed(sessionId));

  // slash-menu popup state (spec §6): dismissal token (FR-9) and selection
  // (FR-7). Component-local — a session switch remounts (keyed by sessionId)
  // and clears them.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const disabled = status === 'done' || status === 'error';

  // ---------- slash-menu popup (FR-5..FR-9/12) ----------

  const token = slashToken(input);
  const filtered = useMemo(() => filterCommands(commands, token ?? ''), [commands, token]);
  const popupOpen = popupVisible({ token, matchCount: filtered.length, dismissedToken, disabled });

  // FR-9: dismissal holds only while the token stays the dismissed one.
  useEffect(() => {
    setDismissedToken((d) => nextDismissed(d, token));
  }, [token]);

  // FR-7: first row on open/refilter (token changed). FR-10: on a registry
  // refresh with an unchanged token, keep the selected name if it survived.
  const selIdxRef = useRef(0);
  selIdxRef.current = selIdx;
  const prevTokenRef = useRef<string | null>(null);
  const prevFilteredRef = useRef<SlashCommandInfo[]>([]);
  useEffect(() => {
    if (prevTokenRef.current !== token) {
      setSelIdx(0);
    } else if (prevFilteredRef.current !== filtered) {
      const name = prevFilteredRef.current[selIdxRef.current]?.name ?? null;
      setSelIdx(refreshSelection(filtered, name));
    }
    prevTokenRef.current = token;
    prevFilteredRef.current = filtered;
  }, [token, filtered]);

  const dismissPopup = () => setDismissedToken(token);

  // FR-8/11: a menu run goes through the NORMAL send path with the bare
  // '/name' — byte-identical to having typed it. No metadata rides along.
  const runCommand = (name: string) => {
    void send(completionText(name, 'run'));
  };

  const send = async (textArg?: string) => {
    const text = textArg ?? input;
    if (!text.trim() || disabled) return;
    // /clear full reset: never enqueues a turn, never creates a user block. The
    // core wipes the transcript + context and echoes session.cleared (below).
    if (isClearCommand(text)) {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      const res = await sessionClear(sessionId);
      if (!res.ok) {
        setSendError(res.error.message);
        setTimeout(() => setSendError(null), 4000);
      }
      return;
    }
    const blockId = crypto.randomUUID();
    dispatch({ t: 'optimisticUser', blockId, text });
    setPinned(true); // FR-20
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const res = await sessionSend(sessionId, blockId, text);
    if (!res.ok) {
      dispatch({ t: 'remove', blockId });
      setInput(text);
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌃C interrupts the running turn (kills the current claude prompt). Only when
    // nothing is selected in the composer, so ⌃C still copies a selection; Cmd+C
    // (macOS copy) is left untouched. No-op path is handled by the core (FR-23).
    if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const el = e.currentTarget;
      if (status === 'running' && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        void sessionInterrupt(sessionId);
        return;
      }
    }
    // slash-menu FR-8/9: while the popup is rendered its keys preempt the
    // composer defaults (Enter-to-send included); everything else falls through.
    if (popupOpen) {
      const action = popupKeyAction(e.key, e.shiftKey);
      if (action) {
        e.preventDefault();
        if (action === 'down' || action === 'up') {
          setSelIdx((i) => moveSelection(filtered.length, i, action === 'down' ? 1 : -1));
        } else if (action === 'run') {
          const sel = filtered[selIdx] ?? filtered[0];
          if (sel) runCommand(sel.name);
        } else if (action === 'complete') {
          const sel = filtered[selIdx] ?? filtered[0];
          if (sel) setInput(completionText(sel.name, 'complete')); // trailing space ends the token → popup closes
        } else {
          dismissPopup();
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  };

  // session-questions FR-20 / permission-guardrails FR-23: the placeholder swaps
  // while a pending question or approval card exists in this session's
  // transcript and reverts when none is.
  const placeholder = composerPlaceholder(
    status,
    errorMessage,
    hasPendingQuestionBlock(state.blocks),
    hasPendingPermissionBlock(state.blocks),
  );

  return (
    <div className="conv-root">
      {/* session-worktree FR-14: pinned bare-checkout notice, above the transcript
          so it never scrolls away. */}
      {meta?.worktree && !worktreeNoticeDismissed && (
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
            <Centered>
              <div className="conv-empty__cwd">{meta && (displayWslCwd(meta.cwd) ?? meta.cwd)}</div>
              <div className="conv-empty__model">{meta?.model.label}</div>
              <div className="conv-empty__hint">waiting for your first prompt</div>
            </Centered>
          ) : (
            groupToolRuns(compactBlocks(state.blocks)).map((item) => (
              <div key={item.kind === 'tool-group' ? item.blockId : item.block.blockId} className="conv-item">
                {item.kind === 'tool-group' ? <ToolGroup blocks={item.blocks} /> : <Block b={item.block} sessionId={sessionId} />}
              </div>
            ))
          )}
        </div>

        {!isPinned && <JumpToLatestChip onClick={jumpToLatest} />}
      </div>

      {/* input bar */}
      <Composer
        status={status}
        disabled={disabled}
        input={input}
        inputRef={inputRef}
        placeholder={placeholder}
        sendError={sendError}
        onInputChange={(e) => {
          setInput(e.target.value);
          autoGrow(e.target);
        }}
        onInputKey={onInputKey}
        onSend={() => void send()}
        popupOpen={popupOpen}
        filtered={filtered}
        selIdx={selIdx}
        onHover={setSelIdx}
        onRun={runCommand}
        onDismiss={dismissPopup}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="conv-centered">{children}</div>;
}

// The per-block renderer moved to ./Block.tsx — agent-tab renders a subagent's
// transcript with the same component, so there is exactly one of it.

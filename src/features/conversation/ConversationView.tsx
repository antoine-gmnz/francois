import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SlashCommandInfo } from '../../../contract/common';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { sessionClear, sessionInterrupt, sessionSend } from '../../lib/api';
import Block, { ToolGroup } from './Block';
import Composer from './Composer';
import { compactBlocks, groupToolRuns, isClearCommand, TRANSCRIPT_TEXT_SELECT_STYLE } from './conversation-blocks';
import JumpToLatestChip from './JumpToLatestChip';
import ResumeFailBanner from './ResumeFailBanner';
import { useConversationTranscript } from './useConversationTranscript';
import {
  atFirstLine,
  atLastLine,
  getHistory,
  recallNext,
  recallPrev,
  recordSent,
  type Browse,
} from './message-history';
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

  // message-history §6: the current walk through this session's sent messages.
  // Component-local on purpose — a session switch remounts this view and the
  // walk resets (FR-10), while the history itself lives in the module map (FR-11).
  const [browse, setBrowse] = useState<Browse | null>(null);

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
    setBrowse(null); // message-history FR-9: sending (or /clear) ends the walk.
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
      return; // message-history FR-1b: a failed send is never recorded.
    }
    // message-history FR-1: the sent text becomes this session's newest entry
    // (slash commands and consecutive duplicates are dropped by recordSent).
    recordSent(sessionId, text);
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
    // message-history FR-13: after the popup keys, before Enter-to-send. Only
    // ArrowUp/ArrowDown are touched, and only at the edges of the draft (FR-2/FR-5)
    // — otherwise the browser's own caret movement wins.
    if (e.key === 'ArrowUp') {
      const el = e.currentTarget;
      if (atFirstLine(el.value, el.selectionStart, el.selectionEnd)) {
        const step = recallPrev(getHistory(sessionId), browse, input);
        if (step) {
          e.preventDefault();
          setBrowse(step.browse);
          // FR-4: at the oldest entry, a repeated ArrowUp is still swallowed (no
          // caret movement, per §7/FR-2) but must not touch the caret — the user
          // may have repositioned it inside the recalled text.
          if (step.changed) applyRecall(step.text);
          return;
        }
      }
    } else if (e.key === 'ArrowDown') {
      const el = e.currentTarget;
      if (atLastLine(el.value, el.selectionStart, el.selectionEnd)) {
        const step = recallNext(getHistory(sessionId), browse);
        if (step) {
          e.preventDefault();
          setBrowse(step.browse);
          applyRecall(step.text);
          return;
        }
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

  // message-history FR-7: caret at the end of the recalled text + a re-run of the
  // auto-grow sizing. The textarea is controlled, so the DOM only holds the new
  // value after the commit — hence the layout effect. When the recalled text
  // happens to already equal what's on screen (e.g. entering browsing while the
  // draft already matches the newest entry) no commit is coming, so do it
  // inline instead. Callers must not invoke this at all when nothing should
  // change — see the FR-4 `step.changed` guard around ArrowUp above, which keeps
  // a repeated ArrowUp at the oldest entry from forcing the caret to the end.
  const recallCaretRef = useRef(false);
  const applyRecall = (text: string) => {
    setInput(text);
    const el = inputRef.current;
    if (el && el.value === text) {
      el.setSelectionRange(text.length, text.length);
      autoGrow(el);
      return;
    }
    recallCaretRef.current = true;
  };
  useLayoutEffect(() => {
    if (!recallCaretRef.current) return;
    recallCaretRef.current = false;
    const el = inputRef.current;
    if (!el) return;
    el.setSelectionRange(el.value.length, el.value.length);
    autoGrow(el);
  }, [input]);

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
          // message-history FR-8: any edit (typing, paste, delete) ends the walk;
          // the edited text becomes the live draft a later ArrowDown restores.
          setBrowse(null);
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

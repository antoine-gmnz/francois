// transcript-perf FR-1 — the composer's own state, lifted OUT of
// ConversationView and into this component so a keystroke re-renders this
// subtree only, never the transcript above it. Everything that used to live
// on ConversationView's own state and only ever fed the composer — `input`,
// `sendError`, `browse` (message-history walk), `dismissedToken`/`selIdx`
// (slash menu), and the session-attachments hook — lives here now. The
// pending-queue strip (transcript-perf §6..8) is new state of the same kind:
// per-session, must outlive this component's keyed remount, so it lives in
// ./pending-queue rather than as local state.
//
// `<DropOverlay/>` (session-attachments) moves here too, since it exists
// exactly while `attachments` does — its `position: absolute; inset: 0`
// resolves against `.conv-root` (the nearest positioned ancestor) regardless
// of which descendant renders it, so moving it deeper in the tree does not
// change what it covers (conversation.css has no z-index it could lose to).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionMeta, SessionStatus, SlashCommandInfo } from '../../../contract/common';
import { isBusyStatus, isTerminalStatus } from '../../../contract/fleet-board';
import { sessionClear, sessionInterrupt, sessionSend, sessionUnqueue } from '../../lib/api';
import Composer from './Composer';
import { isClearCommand, readingWindowHint, RESTORING_PLACEHOLDER, type TranscriptDispatch } from './conversation-blocks';
import { getDraft, setDraft } from './composer-draft';
import { documentHasSelection, shouldFocusComposer } from './composer-focus';
import {
  atFirstLine,
  atLastLine,
  getHistory,
  recallNext,
  recallPrev,
  recordSent,
  type Browse,
} from './message-history';
import { composerPlaceholder } from '../questions/question-card';
import { sessionCapability } from '../../lib/runtimeCapability';
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
import DropOverlay from './DropOverlay';
import { useSessionAttachments } from './useSessionAttachments';
import { appendToDraft, parkPrompt, resolvePrompt, usePendingQueue, wasWronglyOptimistic } from './pending-queue';
import './conversation.css';

export interface ComposerPaneProps {
  sessionId: string;
  /** split-session FR-6: see ConversationViewProps.inert. */
  inert: boolean;
  /**
   * Whether this composer is ON SCREEN — see ConversationViewProps.visible. It
   * gates exactly what `inert` gates and for the same reason: the two
   * document/webview-level attachment gestures. The main pane now holds up to
   * three transcripts mounted at once, so without this a single paste would
   * stage the image into all three sessions.
   */
  visible: boolean;
  onFocusRequest?: () => void;
  inertFooter?: ReactNode;
  status: SessionStatus;
  errorMessage: string | undefined;
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
  commands: SlashCommandInfo[];
  meta: SessionMeta | null;
  /** For the idle-send optimistic block (FR-10) and its rollback on failure/reconciliation (FR-11/13). */
  dispatch: TranscriptDispatch;
  /** FR-20: an idle send still pins the transcript to the bottom. */
  setPinned: (value: boolean) => void;
  /**
   * session-switch-loader FR-8/FR-9: whether this session's transcript is
   * still showing the loading skeleton — swaps the placeholder and the
   * hint-bar's right slot for as long as it is true. The composer's
   * `disabled` gate (above, from `status`) is untouched by this.
   */
  showSkeleton: boolean;
}

export default function ComposerPane({
  sessionId,
  inert,
  visible,
  onFocusRequest,
  inertFooter,
  status,
  errorMessage,
  hasPendingQuestion,
  hasPendingPermission,
  commands,
  meta,
  dispatch,
  setPinned,
  showSkeleton,
}: ComposerPaneProps) {
  const disabled = isTerminalStatus(status);

  // The composer text. Seeded from — and mirrored back into — the per-session
  // draft map, because this component is keyed by sessionId (via
  // ConversationView): switching sessions unmounts it, and without the map a
  // half-typed prompt would be lost (see ./composer-draft).
  const [input, setInput] = useState(() => getDraft(sessionId));
  const [sendError, setSendError] = useState<string | null>(null);

  // slash-menu popup state (spec §6): dismissal token (FR-9) and selection (FR-7).
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState(0);

  // message-history §6: the current walk through this session's sent messages.
  const [browse, setBrowse] = useState<Browse | null>(null);

  // transcript-perf §6: this session's pending queue, reactive.
  const pending = usePendingQueue(sessionId);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  };

  // Mirror every composer edit into the draft map. An effect rather than a
  // wrapper around setInput, so it also covers writes from elsewhere
  // (attachment refs, history recall, a failed send putting the text back,
  // a retracted pending prompt) — and it runs on commit, so the map is
  // already current when a session switch unmounts this component.
  useEffect(() => {
    setDraft(sessionId, input);
  }, [sessionId, input]);

  // A restored multi-line draft must come back at the height it had.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== '') autoGrow(el);
  }, []);

  // split-session FR-5/FR-6: selecting a pane hands the caret to its composer.
  const wasInertRef = useRef(inert);
  useEffect(() => {
    const wasInert = wasInertRef.current;
    wasInertRef.current = inert;
    if (shouldFocusComposer({ wasInert, inert, hasSelection: documentHasSelection() })) {
      inputRef.current?.focus();
    }
  }, [inert]);

  // ---------- session-attachments ----------
  // `active` is what claims the two GLOBAL gestures (document paste, the
  // webview drag-drop channel), so it must name the one composer a gesture
  // could have been meant for: focused (not inert) AND on screen.
  const attachments = useSessionAttachments({ sessionId, input, setInput, inputRef, autoGrow, active: !inert && visible });

  // ---------- slash-menu popup (FR-5..FR-9/12) ----------

  const token = slashToken(input);
  const filtered = useMemo(() => filterCommands(commands, token ?? ''), [commands, token]);
  const interactiveCommandsCapability = sessionCapability(meta, 'interactiveCommands');
  const popupOpen = popupVisible({
    token,
    matchCount: filtered.length,
    dismissedToken,
    disabled,
    available: interactiveCommandsCapability.available,
  });

  useEffect(() => {
    setDismissedToken((d) => nextDismissed(d, token));
  }, [token]);

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

  const runCommand = (name: string) => {
    void send(completionText(name, 'run'));
  };

  const send = async (textArg?: string) => {
    const text = textArg ?? input;
    if (!text.trim() || disabled) return;
    setBrowse(null); // message-history FR-9: sending (or /clear) ends the walk.
    if (isClearCommand(text)) {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      attachments.commit('');
      const res = await sessionClear(sessionId);
      if (!res.ok) {
        setSendError(res.error.message);
        setTimeout(() => setSendError(null), 4000);
      }
      return;
    }
    const blockId = crypto.randomUUID();
    // transcript-perf FR-10: a busy session parks the prompt instead of
    // creating a transcript block — the core will only mint it at drain time
    // (turn.rs's begin_turn), and rendering it now is exactly the "renders
    // inside the running reply" bug this feature fixes.
    const guessedBusy = isBusyStatus(status);
    if (guessedBusy) {
      parkPrompt(sessionId, blockId, text);
    } else {
      dispatch({ t: 'optimisticUser', blockId, text });
      setPinned(true); // FR-20
    }
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const res = await sessionSend(sessionId, blockId, text);
    if (!res.ok) {
      // FR-13: remove the blockId from BOTH — one of these is a no-op depending
      // on which branch above ran, and both are safe unconditionally.
      dispatch({ t: 'remove', blockId });
      resolvePrompt(sessionId, blockId);
      setInput(text);
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
      return; // message-history FR-1b: a failed send is never recorded.
    }
    // FR-11: reconcile a wrong guess. The only miss that needs correcting here
    // is "guessed idle, actually queued" — the optimistic block just dispatched
    // has to come back out and the prompt parked instead. The opposite miss
    // ("guessed busy, actually ran now") is already correctly parked and
    // resolves itself at the imminent message.user (FR-12) — see
    // ./pending-queue's wasWronglyOptimistic.
    if (wasWronglyOptimistic(guessedBusy, res.data.queued)) {
      dispatch({ t: 'remove', blockId });
      parkPrompt(sessionId, blockId, text);
    }
    attachments.commit(text);
    recordSent(sessionId, text);
  };

  // FR-17: retract a still-parked prompt. `removed: false` (the drain won the
  // race) leaves the composer untouched — the row clears on its own via the
  // global message.user resolution (FR-12/FR-18).
  const onRetractPending = async (blockId: string, text: string) => {
    const res = await sessionUnqueue(sessionId, blockId);
    if (res.ok && res.data.removed) {
      resolvePrompt(sessionId, blockId);
      applyRecall(appendToDraft(input, text));
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const el = e.currentTarget;
      if (isBusyStatus(status) && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        void sessionInterrupt(sessionId);
        return;
      }
    }
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
          if (sel) setInput(completionText(sel.name, 'complete'));
        } else {
          dismissPopup();
        }
        return;
      }
    }
    if (e.key === 'ArrowUp') {
      const el = e.currentTarget;
      if (atFirstLine(el.value, el.selectionStart, el.selectionEnd)) {
        const step = recallPrev(getHistory(sessionId), browse, input);
        if (step) {
          e.preventDefault();
          setBrowse(step.browse);
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

  // session-switch-loader FR-8: while the skeleton is up this wins over every
  // other placeholder (question/permission/error/done) — the transcript is not
  // hydrated, so none of those states can be genuine yet anyway (they all key
  // off `state.blocks`, which is still empty).
  const placeholder = showSkeleton
    ? RESTORING_PLACEHOLDER
    : composerPlaceholder(status, errorMessage, hasPendingQuestion, hasPendingPermission);
  // FR-9: derived from RENDER_WINDOW, never a literal — replaces the context
  // percent slot for as long as the skeleton is up (the figure a real session
  // would show is not yet meaningful for one still restoring).
  const readingHint = showSkeleton ? readingWindowHint() : null;

  // split-by-4 FR-11: at 3-4 panes the grid substitutes a PaneFooter for the
  // whole composer — a density decision, not a focus one (see
  // ConversationViewProps.inertFooter). DropOverlay still renders: `active`
  // above is false while inert, so its drag-drop listener was never installed
  // and the overlay is already inert by construction — rendering it here too
  // just keeps this branch structurally identical to the one below.
  if (inert && inertFooter) {
    return (
      <>
        <DropOverlay state={attachments.overlay} />
        {inertFooter}
      </>
    );
  }

  return (
    <>
      <DropOverlay state={attachments.overlay} />
      <Composer
        inert={inert}
        onInertClick={onFocusRequest}
        status={status}
        disabled={disabled}
        input={input}
        inputRef={inputRef}
        placeholder={placeholder}
        sendError={sendError}
        attachError={attachments.attachError}
        attachments={attachments.chips}
        contextPercent={
          meta && meta.contextLimitTokens > 0
            ? Math.min(100, Math.round((meta.contextUsedTokens / meta.contextLimitTokens) * 100))
            : null
        }
        readingHint={readingHint}
        onAttachClick={attachments.onAttachClick}
        onRemoveAttachment={attachments.onRemoveAttachment}
        onInputChange={(e) => {
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
        popupUnavailableReason={interactiveCommandsCapability.available ? null : (interactiveCommandsCapability.reason ?? null)}
        pending={pending}
        onRetractPending={(blockId, text) => void onRetractPending(blockId, text)}
      />
    </>
  );
}

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
import type { DeliveryMode, RuntimeQueueEntry, SessionMeta, SessionStatus, SlashCommandInfo } from '../../../contract/common';
import { isBusyStatus, isTerminalStatus } from '../../../contract/fleet-board';
import { MAX_PENDING_INTENTS } from '../../../contract/pi-turn-controls';
import { sessionAcknowledgePolicy, sessionClear, sessionClearQueue, sessionInterrupt, sessionSend, sessionSubmit, sessionUnqueue } from '../../lib/api';
import Composer, { type PiComposerProps } from './Composer';
import { isClearCommand, readingWindowHint, RESTORING_PLACEHOLDER, type TranscriptDispatch } from './conversation-blocks';
import { getDraft, setDraft } from './composer-draft';
import { documentHasSelection, shouldFocusComposer } from './composer-focus';
import { resolveEffectiveChoice, resolveKeyDelivery, type DeliveryChoice } from './delivery-mode';
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
  commandInvocation,
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
import { exceedsMessageByteCap, isQueueFull, shouldUnqueueAfterResend, useQueueEntries } from './pi-queue';
import {
  compactionBannerText,
  dismissCompactionProgress,
  retryBannerText,
  useCompactionProgress,
  useRetryProgress,
} from './pi-turn-progress';
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

  // transcript-perf §6: this session's pending queue, reactive. Legacy
  // (non-Pi) runtimes only — a Pi session never parks anything here.
  const pending = usePendingQueue(sessionId);

  // pi-turn-controls: a Pi session submits through francois:session:submit —
  // a different admissions model (explicit delivery mode, a core-owned
  // ledger) entirely separate from the legacy pending-queue strip above,
  // which stays untouched for every other runtime.
  const isPi = meta?.agentRuntime === 'pi';
  const queueEntries = useQueueEntries(sessionId);
  const compaction = useCompactionProgress(sessionId);
  const retry = useRetryProgress(sessionId);
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryChoice>('followUp');
  const [stopping, setStopping] = useState(false);
  // pi-skills-capabilities FR-5: a send refused with RUNTIME_POLICY_REQUIRED —
  // the acknowledgment prompt (Composer's `pi.policyRequired`) replaces the
  // plain error banner until the user acts; never set for any other failure.
  const [policyRequired, setPolicyRequired] = useState(false);
  const steeringCapability = sessionCapability(meta, 'steering');
  const followUpsCapability = sessionCapability(meta, 'followUps');
  const effectiveChoice = resolveEffectiveChoice(deliveryChoice, steeringCapability.available, followUpsCapability.available);

  // FR-6: a Stop confirmed (or refused) while the session settled some other
  // way must not leave the button stuck reading "Stopping…".
  useEffect(() => {
    if (!isBusyStatus(status)) setStopping(false);
  }, [status]);

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
  const wasInertRef = useRef(inert || !visible);
  useEffect(() => {
    const wasInert = wasInertRef.current;
    wasInertRef.current = inert || !visible;
    if (shouldFocusComposer({ wasInert, inert: inert || !visible, hasSelection: documentHasSelection() })) {
      inputRef.current?.focus();
    }
  }, [inert, visible]);

  // ---------- session-attachments ----------
  // `active` is what claims the two GLOBAL gestures (document paste, the
  // webview drag-drop channel), so it must name the one composer a gesture
  // could have been meant for: focused (not inert) AND on screen.
  const imagesCapability = sessionCapability(meta, 'images');
  const attachments = useSessionAttachments({ sessionId, input, setInput, inputRef, autoGrow, active: !inert && visible, imagesCapability });

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

  // pi-skills-capabilities FR-1/FR-2: submits the command's exact `invocation`
  // (colon commands etc.) when the registry supplied one, else the legacy
  // `/name` every other runtime already sends — through the SAME admission
  // path as typed text (never a separate skills_run call).
  const runCommand = (command: SlashCommandInfo) => {
    void send(commandInvocation(command, 'run'));
  };

  // pi-turn-controls §5/FR-1..FR-4: the explicit-delivery submit. `delivery`
  // is resolved at the CALL SITE (onInputKey knows the pressed key's altKey;
  // every other caller falls back to the plain Enter/Send resolution) so this
  // stays one function regardless of what triggered it.
  const sendPi = async (text: string, delivery: DeliveryMode | null) => {
    if (delivery === null) {
      setSendError('No delivery mode is available for this session right now.');
      setTimeout(() => setSendError(null), 4000);
      return;
    }
    if (exceedsMessageByteCap(text)) {
      setSendError('Message is too large — the limit is 1 MiB.');
      setTimeout(() => setSendError(null), 4000);
      return;
    }
    if (isQueueFull(queueEntries)) {
      setSendError(`Too many pending messages — clear some first (max ${MAX_PENDING_INTENTS}).`);
      setTimeout(() => setSendError(null), 4000);
      return;
    }
    const clientMessageId = crypto.randomUUID();
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    // FR-3/FR-4: NO optimistic transcript block — the block is created only by
    // the eventual `message.user` runtime event, carrying this clientMessageId.
    const res = await sessionSubmit({
      sessionId,
      clientMessageId,
      text,
      delivery,
      attachmentIds: attachments.chips.map((a) => a.id),
    });
    if (!res.ok) {
      setInput(text);
      // pi-skills-capabilities FR-5: the acknowledgment banner takes over —
      // never stack a duplicate generic error on top of it.
      if (res.error.code === 'RUNTIME_POLICY_REQUIRED') {
        setPolicyRequired(true);
      } else {
        setSendError(res.error.message);
        setTimeout(() => setSendError(null), 4000);
      }
      return;
    }
    attachments.commit(text);
    recordSent(sessionId, text);
  };

  // FR-5: never auto-acknowledged — this fires only on the user's own click.
  // Clears the prompt whether or not it succeeded; a failure surfaces as the
  // ordinary transient error, so the user is never stuck on a dead banner.
  const acknowledgePolicy = async () => {
    const res = await sessionAcknowledgePolicy(sessionId);
    setPolicyRequired(false);
    if (!res.ok) {
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  const send = async (textArg?: string, delivery?: DeliveryMode | null) => {
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
    if (!attachments.canSubmit(text)) return;

    if (isPi) {
      await sendPi(text, delivery ?? resolveKeyDelivery(status, false, effectiveChoice));
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

  // pi-turn-controls FR-5 (amended): session_unqueue (blockId = the entry's
  // clientMessageId) removes any entry Pi does NOT own — an intent still
  // 'admitting' (the composer strip's ✕), or one of the three recoverable
  // terminal states (the strip's "Discard"). `removed: false` is not an
  // error: it means Pi already accepted the entry (or it was already gone)
  // between the click and this response — the strip's own next
  // `queue.changed` is what actually repaints/clears the row either way, so
  // there is nothing to reconcile locally.
  const onUnqueuePi = async (clientMessageId: string) => {
    const res = await sessionUnqueue(sessionId, clientMessageId);
    if (!res.ok) {
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  // FR-3: Resend always mints a NEW clientMessageId, and reuses the entry's
  // OWN attachmentIds — never the composer's currently-staged ones, which may
  // be unrelated to this historical entry or already released.
  const onResendPi = async (entry: RuntimeQueueEntry) => {
    const delivery = resolveKeyDelivery(status, false, effectiveChoice);
    if (delivery === null) {
      setSendError('No delivery mode is available for this session right now.');
      setTimeout(() => setSendError(null), 4000);
      return;
    }
    const res = await sessionSubmit({
      sessionId,
      clientMessageId: crypto.randomUUID(),
      text: entry.text,
      delivery,
      attachmentIds: entry.attachmentIds,
    });
    if (!res.ok) {
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
      return;
    }
    // FR-3 (amended): the resend landed under a NEW id — drop the stale
    // recovery row so the strip does not show both. Never reached on the
    // failure above (shouldUnqueueAfterResend(false)): the user must not
    // lose the only copy of the text.
    if (shouldUnqueueAfterResend(res.ok)) {
      void sessionUnqueue(sessionId, entry.clientMessageId);
    }
  };

  // FR-5: bulk-drains every entry Pi has already accepted; the core's own
  // `queue.changed` repaints the strip once it applies — no local reconciliation.
  const onClearQueuePi = async () => {
    const res = await sessionClearQueue(sessionId);
    if (!res.ok) {
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  // FR-6/FR-7: shared by the composer's Stop button and the ⌃C shortcut below
  // — session_interrupt now resolves only AFTER the cancel is confirmed, so
  // this tracks the round trip for the "Stopping…" state. The `stopping`
  // guard is cosmetic only: a second session_interrupt is idempotent core-side.
  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    const res = await sessionInterrupt(sessionId);
    setStopping(false);
    if (!res.ok) {
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const el = e.currentTarget;
      if (isBusyStatus(status) && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        void handleStop();
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
          if (sel) runCommand(sel);
        } else if (action === 'complete') {
          const sel = filtered[selIdx] ?? filtered[0];
          if (sel) setInput(commandInvocation(sel, 'complete'));
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
      // pi-turn-controls §3: Alt+Enter is always an explicit follow-up;
      // plain Enter follows the toggle while busy. Ignored (undefined) for
      // every non-Pi runtime — `send` falls back to its existing behaviour.
      void send(undefined, isPi ? resolveKeyDelivery(status, e.altKey, effectiveChoice) : undefined);
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

  // pi-turn-controls: everything Composer's `pi` prop needs, computed once
  // per render rather than inline in the JSX below. `null` for every non-Pi
  // session — Composer then renders exactly as it did before this feature.
  const piProps: PiComposerProps | null = isPi
    ? {
        busy: isBusyStatus(status),
        deliveryChoice: effectiveChoice ?? deliveryChoice,
        canSteer: steeringCapability.available,
        canFollowUp: followUpsCapability.available,
        onChangeDelivery: setDeliveryChoice,
        queue: queueEntries,
        onUnqueue: (clientMessageId) => void onUnqueuePi(clientMessageId),
        onResend: (entry) => void onResendPi(entry),
        onClearQueue: () => void onClearQueuePi(),
        stopping,
        onStop: () => void handleStop(),
        compactionNotice: compactionBannerText(compaction),
        compactionFailed: compaction?.state === 'failed',
        onDismissCompaction: () => dismissCompactionProgress(sessionId),
        retryNotice: retryBannerText(retry),
        policyRequired,
        onAcknowledgePolicy: () => void acknowledgePolicy(),
      }
    : null;

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
        attachError={attachments.attachError ?? (imagesCapability.available ? null : (imagesCapability.reason ?? 'Images are unavailable for this session.'))}
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
        pi={piProps}
      />
    </>
  );
}

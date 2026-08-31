import type { RefObject } from 'react';
import type { SessionStatus, SlashCommandInfo } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import type { Attachment } from '../../../contract/session-attachments';
import SlashMenu from '../commands/SlashMenu';
import AttachmentChip from './AttachmentChip';
import { composerErrorBanners } from './attachments';
import { firstLine, type PendingPrompt } from './pending-queue';

// The SESSION tab input bar: slash-menu popup (FR-5) anchored above it, the
// transient send-error banner, the pending-queue strip (transcript-perf §6..8),
// and the composer textarea itself. Presentational only — every bit of popup/
// send/attachments/pending-queue logic (FR-5..FR-12, FR-20/23,
// transcript-perf FR-10..18) lives in ./ComposerPane, which owns the state
// this component reads and writes through props.

export interface ComposerProps {
  status: SessionStatus;
  disabled: boolean;
  input: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  placeholder: string;
  /** A refused/failed turn (transient). Rendered in its OWN slot — see `attachError`. */
  sendError: string | null;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onInputKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** design-refresh FR-8: the visible Send button — same send path as Enter. */
  onSend: () => void;
  popupOpen: boolean;
  filtered: SlashCommandInfo[];
  selIdx: number;
  onHover: (i: number) => void;
  onRun: (name: string) => void;
  onDismiss: () => void;
  /** multi-provider-openai FR-20: interactiveCommands' reason when unavailable — forwarded to SlashMenu. */
  popupUnavailableReason: string | null;
  // session-attachments (design §1): presentational only — the staged list and
  // every handler live in ConversationView's useSessionAttachments.
  /** Already filtered to staged IMAGES whose ref is still in the prompt (FR-12). */
  attachments: Attachment[];
  /** The `+` button — opens the native picker in the core. */
  onAttachClick: () => void;
  /** A chip's `×` (FR-13). */
  onRemoveAttachment: (attachment: Attachment) => void;
  /**
   * §7: the attachment refusal line. Its own slot next to `sendError` because the
   * two fail independently — a drop can be refused while a send is failing, and
   * one shared slot hid whichever landed second (see composerErrorBanners).
   */
  attachError: string | null;
  /**
   * design 7a: context used, 0–100, closing the hint row. null when the session
   * reports no limit — there is no denominator, so there is no percentage.
   */
  contextPercent: number | null;
  /**
   * session-switch-loader FR-9: "reading last N of the session", non-null only
   * while the skeleton is up. Takes over the same right-aligned slot
   * `contextPercent` closes the hint row with — the two never show at once.
   */
  readingHint: string | null;
  /**
   * split-session FR-6: this pane is not the focused one. The composer renders
   * IDENTICALLY — same bar, same buttons, same hint row, same height — because
   * a layout that reflows when focus moves is harder to read than one that does
   * not; the focus chip in the pane header is the single signal (see
   * .split-pane__header in app.css).
   *
   * What it changes is reach, not looks. FR-12 gives the keyboard to exactly one
   * pane: the textarea goes `readOnly` and drops out of the tab order, the
   * buttons go inert, and the slash popup cannot open — so a keystroke can never
   * land in the wrong session's turn. A click anywhere on the bar calls
   * `onInertClick`, which focuses the pane; ConversationView's
   * `shouldFocusComposer` then hands it the caret on that edge.
   */
  inert?: boolean;
  /** Focus this pane. Only called while `inert`. */
  onInertClick?: () => void;
  // Paste-to-attach (FR-14) is NOT a prop: the textarea below carries the native
  // `disabled` attribute, and a disabled control fires no paste event, so a
  // handler here would die with the session while drop and `+` keep staging.
  // useSessionAttachments listens at the document instead (subscribeDocumentPaste).

  // ── transcript-perf §6..8: the pending-queue strip ──────────────────────
  /** This session's parked prompts, FIFO. Empty ⇒ the strip renders nothing. */
  pending: readonly PendingPrompt[];
  /** A row's `✕` (FR-17/18). Inert on an unfocused pane (no control renders at all). */
  onRetractPending: (blockId: string, text: string) => void;
}

export default function Composer({
  status,
  disabled,
  input,
  inputRef,
  placeholder,
  sendError,
  onInputChange,
  onInputKey,
  onSend,
  popupOpen,
  filtered,
  selIdx,
  onHover,
  onRun,
  onDismiss,
  popupUnavailableReason,
  attachments,
  onAttachClick,
  onRemoveAttachment,
  attachError,
  contextPercent,
  readingHint,
  inert = false,
  onInertClick,
  pending,
  onRetractPending,
}: ComposerProps) {
  const banners = composerErrorBanners(sendError, attachError);
  // One gate for every interactive part of the bar: while inert the pane does
  // not own the keyboard, so nothing here may be typed into, tabbed to or fired.
  const sendDisabled = disabled || inert || !input.trim();
  return (
    <div className="composer-wrap">
      {/* design-refresh FR-8: capped + centered on the transcript's reading
          column, so the composer lines up with the blocks it answers. It is
          also the positioning context for the two popovers below — they
          anchor to the input bar's width, not the pane's. */}
      <div className="composer-col">
        {/* slash-menu popup — anchored above the input bar, never covering it (FR-5).
            Never on an inert pane: it is driven by the caret, which lives in the
            focused pane's composer. */}
        {popupOpen && !inert && (
          <SlashMenu
            items={filtered}
            selIdx={selIdx}
            onHover={onHover}
            onRun={onRun}
            onDismiss={onDismiss}
            unavailableReason={popupUnavailableReason}
          />
        )}
        {/* One line per failing source, stacked above the bar (the wrapper is what
            is positioned, so a second line pushes the first up instead of
            overlapping it). */}
        {banners.length > 0 && (
          <div className="composer-banners">
            {banners.map((line) => (
              <div key={line} className="send-error-banner">
                {line}
              </div>
            ))}
          </div>
        )}
        {/* transcript-perf design brief: the pending strip sits in the SAME
            slot the banners above already use — a row pushes the composer
            down rather than overlapping it. Empty ⇒ not rendered at all (no
            placeholder, no zero-height wrapper). */}
        {pending.length > 0 && (
          <div className="composer-pending">
            {pending.map((p) => (
              <div key={p.blockId} className="composer-pending__row" title={p.text}>
                <span className="composer-pending__glyph" aria-hidden="true">
                  ⟳
                </span>
                <span className="composer-pending__text">{firstLine(p.text)}</span>
                {/* inert (unfocused pane): read-only, no ✕ — matches the composer's own gate. */}
                {!inert && (
                  <button
                    type="button"
                    className="composer-pending__remove"
                    aria-label="remove queued message"
                    onClick={() => onRetractPending(p.blockId, p.text)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* The click target that focuses an inert pane is the WHOLE bar, so the
            gesture is the same wherever in it you aim (the buttons inside are
            inert while it is, so none of them swallows the click). */}
        <div className="composer-bar" onClick={inert ? onInertClick : undefined}>
          {/* session-attachments (design §1): a sibling of the › glyph, not a
              web-style icon button. Opens the native picker in the core.
              Never disabled BY SESSION STATE: §7 gates *sending* on `disabled`,
              not *staging* — drop (webview-level) and paste (document-level, see
              ComposerProps) stay live in every session state, and the `+` is the
              third gesture for the same thing (§3). It IS inert on an unfocused
              pane, which is a different question: staging into a session you are
              not looking at has no gesture that could have meant it. */}
          <button
            type="button"
            className="composer-attach"
            onClick={onAttachClick}
            disabled={inert}
            tabIndex={inert ? -1 : undefined}
            aria-label="Attach files"
            title="Attach files"
          >
            +
          </button>
          <span className="composer-arrow" style={{ color: disabled ? 'var(--text-disabled)' : 'var(--accent)' }}>
            ›
          </span>
          {/* readOnly, not disabled: a disabled textarea renders in the UA's own
              greyed treatment, which is exactly the focus-dependent look this
              pane is not supposed to have. readOnly looks identical to a live
              field and still refuses every keystroke. */}
          <textarea
            ref={inputRef}
            value={input}
            disabled={disabled}
            readOnly={inert}
            tabIndex={inert ? -1 : undefined}
            placeholder={placeholder}
            onChange={onInputChange}
            onKeyDown={onInputKey}
            rows={1}
            className="composer-input"
          />
          {/* design-refresh FR-8: a visible Send button alongside Enter-to-send. */}
          <button
            type="button"
            disabled={sendDisabled}
            tabIndex={inert ? -1 : undefined}
            onClick={onSend}
            className={sendDisabled ? 'composer-send is-disabled' : 'composer-send'}
          >
            Send
          </button>
        </div>
        {/* session-attachments (design §1): chips for staged images, derived from
            the prompt text — never stored, so they cannot desync from it (FR-12).
            Rendered AFTER .composer-bar on purpose: design §Accessibility wants
            the chips row reachable by keyboard *after* the textarea, so tab does
            not walk every chip's `×` before reaching the input. CSS `order` (see
            conversation.css) puts it back above the bar visually. */}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={onRemoveAttachment} />
            ))}
          </div>
        )}
        {/* design 7a: the hint row is now the app's bottom edge (the status bar
            is gone), so it names the gestures that actually exist HERE — every
            key below is really bound: ⌃C in onInputKey, `@`/`/` by the
            attachment + slash-menu tokens, ⌘K by the global capture listener. */}
        <span className="composer-hint">
          {/* the mock's copy reads "esc interrupt", but the real binding here is
              ⌃C (ComposerPane.onInputKey) — the hint names the hotkey that
              actually fires, not the mock's label; see the handoff. */}
          {isBusyStatus(status) && (
            <span>
              <span className="composer-hint__key">⌃C</span> interrupt
            </span>
          )}
          <span>
            <span className="composer-hint__key">@</span> for files
          </span>
          <span>
            <span className="composer-hint__key">/</span> for commands
          </span>
          <span>
            <span className="composer-hint__key">⌘K</span> commands
          </span>
          <span>
            <span className="composer-hint__key">⇧⏎</span> newline
          </span>
          {/* session-switch-loader FR-9: while the skeleton is up this replaces
              the context readout — the real figure is not yet meaningful for a
              transcript still restoring. */}
          {readingHint !== null ? (
            <span className="composer-hint__ctx">{readingHint}</span>
          ) : (
            contextPercent !== null && <span className="composer-hint__ctx">{contextPercent}% context</span>
          )}
        </span>
      </div>
    </div>
  );
}

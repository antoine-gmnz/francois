import type { RefObject } from 'react';
import type { SlashCommandInfo } from '../../../contract/common';
import type { Attachment } from '../../../contract/session-attachments';
import SlashMenu from '../commands/SlashMenu';
import AttachmentChip from './AttachmentChip';
import { composerErrorBanners } from './attachments';

// The SESSION tab input bar: slash-menu popup (FR-5) anchored above it, the
// transient send-error banner, and the composer textarea itself. Extracted
// verbatim from ConversationView — all the popup/send logic (FR-5..FR-12,
// FR-20/23) stays in the parent, which owns the state it reads and writes.

export interface ComposerProps {
  status: string;
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
  // Paste-to-attach (FR-14) is NOT a prop: the textarea below carries the native
  // `disabled` attribute, and a disabled control fires no paste event, so a
  // handler here would die with the session while drop and `+` keep staging.
  // useSessionAttachments listens at the document instead (subscribeDocumentPaste).
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
  attachments,
  onAttachClick,
  onRemoveAttachment,
  attachError,
}: ComposerProps) {
  const banners = composerErrorBanners(sendError, attachError);
  return (
    <div className="composer-wrap">
      {/* design-refresh FR-8: capped + centered on the transcript's reading
          column, so the composer lines up with the blocks it answers. It is
          also the positioning context for the two popovers below — they
          anchor to the input bar's width, not the pane's. */}
      <div className="composer-col">
        {/* slash-menu popup — anchored above the input bar, never covering it (FR-5) */}
        {popupOpen && <SlashMenu items={filtered} selIdx={selIdx} onHover={onHover} onRun={onRun} onDismiss={onDismiss} />}
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
        <div className="composer-bar">
          {/* session-attachments (design §1): a sibling of the › glyph, not a
              web-style icon button. Opens the native picker in the core.
              Never disabled: §7 gates *sending* on `disabled`, not *staging* —
              drop (webview-level) and paste (document-level, see ComposerProps)
              stay live in every session state, and the `+` is the third gesture
              for the same thing (§3). */}
          <button
            type="button"
            className="composer-attach"
            onClick={onAttachClick}
            aria-label="Attach files"
            title="Attach files"
          >
            +
          </button>
          <span className="composer-arrow" style={{ color: disabled ? 'var(--text-disabled)' : 'var(--accent)' }}>
            ›
          </span>
          <textarea
            ref={inputRef}
            value={input}
            disabled={disabled}
            placeholder={placeholder}
            onChange={onInputChange}
            onKeyDown={onInputKey}
            rows={1}
            className="composer-input"
          />
          {/* design-refresh FR-8: a visible Send button alongside Enter-to-send. */}
          <button
            type="button"
            disabled={disabled || !input.trim()}
            onClick={onSend}
            className={disabled || !input.trim() ? 'composer-send is-disabled' : 'composer-send'}
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
        <span className="composer-hint">
          {/* the mock's copy reads "esc interrupt", but the real binding here is
              ⌃C (ConversationView.onInputKey) — the hint names the hotkey that
              actually fires, not the mock's label; see the handoff. */}
          {status === 'running' && (
            <span>
              <span className="composer-hint__key">⌃C</span> interrupt
            </span>
          )}
          <span>
            <span className="composer-hint__key">⌘K</span> commands
          </span>
          <span>
            <span className="composer-hint__key">⇧⏎</span> newline
          </span>
        </span>
      </div>
    </div>
  );
}

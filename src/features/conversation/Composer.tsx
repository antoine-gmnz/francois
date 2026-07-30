import type { RefObject } from 'react';
import type { SlashCommandInfo } from '../../../contract/common';
import SlashMenu from '../commands/SlashMenu';

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
}: ComposerProps) {
  return (
    <div className="composer-wrap">
      {/* design-refresh FR-8: capped + centered on the transcript's reading
          column, so the composer lines up with the blocks it answers. It is
          also the positioning context for the two popovers below — they
          anchor to the input bar's width, not the pane's. */}
      <div className="composer-col">
        {/* slash-menu popup — anchored above the input bar, never covering it (FR-5) */}
        {popupOpen && <SlashMenu items={filtered} selIdx={selIdx} onHover={onHover} onRun={onRun} onDismiss={onDismiss} />}
        {sendError && <div className="send-error-banner">{sendError}</div>}
        <div className="composer-bar">
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

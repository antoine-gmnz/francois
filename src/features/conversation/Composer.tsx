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
  popupOpen,
  filtered,
  selIdx,
  onHover,
  onRun,
  onDismiss,
}: ComposerProps) {
  return (
    <div className="composer-wrap">
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
        <span className="composer-hint">
          {status === 'running' && (
            <span>
              <span className="composer-hint__key">⌃C</span> interrupt
            </span>
          )}
          <span>⌘K palette</span>
        </span>
      </div>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { clearDraft, getDraft, setDraft } from './composer-draft';

// The store is module-scoped by design, so every test uses its own session ids.

describe('composer drafts', () => {
  it('is empty for a session that was never typed in', () => {
    expect(getDraft('unknown-session')).toBe('');
  });

  it('keeps one draft per session so a switch and back restores the text', () => {
    setDraft('draft-a', 'half a prompt');
    setDraft('draft-b', 'a different prompt');

    expect(getDraft('draft-a')).toBe('half a prompt');
    expect(getDraft('draft-b')).toBe('a different prompt');
  });

  it('overwrites on every keystroke', () => {
    setDraft('draft-typing', 'ru');
    setDraft('draft-typing', 'run the tests');

    expect(getDraft('draft-typing')).toBe('run the tests');
  });

  it('preserves whitespace-only and multi-line drafts verbatim', () => {
    setDraft('draft-multiline', 'first line\nsecond line\n');
    expect(getDraft('draft-multiline')).toBe('first line\nsecond line\n');

    setDraft('draft-spaces', '  ');
    expect(getDraft('draft-spaces')).toBe('  ');
  });

  it('forgets a draft emptied by a send or a clear', () => {
    setDraft('draft-sent', 'about to be sent');
    setDraft('draft-sent', '');

    expect(getDraft('draft-sent')).toBe('');
  });

  it('clearDraft drops a single session', () => {
    setDraft('draft-gone', 'text');
    setDraft('draft-stays', 'text');
    clearDraft('draft-gone');

    expect(getDraft('draft-gone')).toBe('');
    expect(getDraft('draft-stays')).toBe('text');
  });
});

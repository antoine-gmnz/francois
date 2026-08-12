import { describe, expect, it } from 'vitest';
import { usageLimitNoticeText, usageLimitResetAt } from './usage-limit';

describe('usageLimitResetAt', () => {
  it('reads the epoch the CLI appends to the limit message', () => {
    // The real wire string, verbatim.
    expect(usageLimitResetAt('Claude AI usage limit reached|1753272000')).toBe(1753272000000);
  });

  it('takes a 13-digit value as milliseconds already', () => {
    expect(usageLimitResetAt('Claude AI usage limit reached|1753272000000')).toBe(1753272000000);
  });

  it('is null when the message carries no timestamp', () => {
    expect(usageLimitResetAt('You have reached your usage limit')).toBeNull();
    // A pipe with something else after it is not a reset time.
    expect(usageLimitResetAt('usage limit reached|soon')).toBeNull();
  });
});

describe('usageLimitNoticeText', () => {
  it('names the reset time when the message carries one', () => {
    const line = usageLimitNoticeText('Claude AI usage limit reached|1753272000', () => 'Tue 5:00 PM');
    expect(line).toBe('usage limit reached — this session stays open; send again after Tue 5:00 PM');
  });

  it('falls back to a timeless line rather than printing a bogus date', () => {
    expect(usageLimitNoticeText('You have reached your usage limit')).toBe(
      'usage limit reached — this session stays open; send again once your plan window resets',
    );
  });

  it('says the session is still usable — the whole point of the notice', () => {
    // The bug this replaces: the limit message landed in the composer placeholder
    // of a session marked terminally errored, so the input stayed disabled for
    // good. Whatever the wording, it must not read as a dead session.
    expect(usageLimitNoticeText('Claude AI usage limit reached|1753272000', () => 'x')).toContain('stays open');
  });
});

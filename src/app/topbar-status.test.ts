import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../contract/common';
import { statusToneClass } from './topbar';

// Replaces SessionRow's old inline `style={{ color: statusColor }}`
// on `.session-row__status` with a state modifier class, coloured from
// app.css's design tokens. `SessionStatus` is a closed union (contract/common.ts),
// so every member gets its own exact class name — nothing falls through to a
// computed/open-ended value.
describe('statusToneClass', () => {
  it('names one modifier class per SessionStatus member, exhaustively', () => {
    const statuses: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input', 'idle', 'done', 'error'];
    for (const status of statuses) {
      expect(statusToneClass(status)).toBe(`session-row__status--${status}`);
    }
  });

  it('never returns the same class for two different statuses', () => {
    const statuses: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input', 'idle', 'done', 'error'];
    const classes = statuses.map(statusToneClass);
    expect(new Set(classes).size).toBe(statuses.length);
  });
});

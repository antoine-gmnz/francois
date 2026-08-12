import { describe, expect, it } from 'vitest';
import { assistantColors, classifyToolStart } from '../../contract/conversation-view';
import { SESSION_STATUSES, STATUS_COLOR } from '../../contract/fleet-board';
import { toneVar } from './tone';

describe('toneVar', () => {
  it('maps the assistant body literals onto the text ladder', () => {
    expect(toneVar('#e6e9ef')).toBe('var(--text-strong)');
    expect(toneVar('#c3c9d4')).toBe('var(--text-2)');
    expect(toneVar('#8b93a3')).toBe('var(--text-dim)');
  });

  it('maps the glyph and status hues onto their tokens', () => {
    expect(toneVar('#c3f53f')).toBe('var(--accent)');
    expect(toneVar('#8ea84a')).toBe('var(--accent-dim)');
    expect(toneVar('#e0a84e')).toBe('var(--attn)');
    expect(toneVar('#4fae86')).toBe('var(--success)');
    expect(toneVar('#d1685e')).toBe('var(--error)');
    expect(toneVar('#8fbab8')).toBe('var(--hue-teal)');
    expect(toneVar('#b39ede')).toBe('var(--hue-purple)');
  });

  it('is case-insensitive', () => {
    expect(toneVar('#C3C9D4')).toBe('var(--text-2)');
  });

  it('passes a token and an unmapped colour through', () => {
    expect(toneVar('var(--text-dim)')).toBe('var(--text-dim)');
    expect(toneVar('#123456')).toBe('#123456');
  });

  // The whole point: nothing a contract emits may reach the DOM as a raw hex, or
  // that element stays dark-palette on a white surface.
  it('covers every colour contract/conversation-view.ts can emit', () => {
    const emitted = [
      ...Object.values(assistantColors(true)),
      ...Object.values(assistantColors(false)),
      ...['Read', 'Grep', 'Search', 'Edit', 'Write', 'Bash', 'Task'].flatMap((tool) => {
        const c = classifyToolStart(tool, 'summary', 'b1');
        return [c.glyphColor, c.bodyColor];
      }),
    ];
    for (const color of emitted) {
      expect(toneVar(color), color).toMatch(/^var\(--/);
    }
  });

  it('covers every colour contract/fleet-board.ts can emit', () => {
    for (const status of SESSION_STATUSES) {
      expect(toneVar(STATUS_COLOR[status]), status).toMatch(/^var\(--/);
    }
  });

  // The acid is the "one live thing per view" signal — it must survive the
  // remapping as the accent, not collapse into a neighbouring token.
  it('keeps the running/active status on the accent', () => {
    expect(toneVar(STATUS_COLOR.running)).toBe('var(--accent)');
    expect(toneVar(STATUS_COLOR.starting)).toBe('var(--accent-dim)');
  });
});

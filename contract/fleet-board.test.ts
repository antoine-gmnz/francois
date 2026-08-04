import { describe, it, expect } from 'vitest';
import {
  SESSION_STATUSES,
  STATUS_COLOR,
  STATUS_LABEL,
  countRunning,
  formatRelativeTime,
  isBusyStatus,
  isTerminalStatus,
  statusNeedsAttention,
  statusPulses,
} from './fleet-board';
import type { SessionStatus } from './common';

const ALL = SESSION_STATUSES;

describe('formatRelativeTime', () => {
  const base = 1_700_000_000_000;
  it('reads "now" under 10s', () => {
    expect(formatRelativeTime(base, base)).toBe('now');
    expect(formatRelativeTime(base - 9_000, base)).toBe('now');
  });
  it('reads seconds at the 10s..59s boundary', () => {
    expect(formatRelativeTime(base - 10_000, base)).toBe('10s');
    expect(formatRelativeTime(base - 59_000, base)).toBe('59s');
  });
  it('rolls over to minutes / hours / days', () => {
    expect(formatRelativeTime(base - 60_000, base)).toBe('1m');
    expect(formatRelativeTime(base - 59 * 60_000, base)).toBe('59m');
    expect(formatRelativeTime(base - 60 * 60_000, base)).toBe('1h');
    expect(formatRelativeTime(base - 23 * 3_600_000, base)).toBe('23h');
    expect(formatRelativeTime(base - 24 * 3_600_000, base)).toBe('1d');
    expect(formatRelativeTime(base - 5 * 86_400_000, base)).toBe('5d');
  });
  it('clamps a future timestamp (clock skew) to "now"', () => {
    expect(formatRelativeTime(base + 5_000, base)).toBe('now');
  });
});

describe('countRunning', () => {
  it('counts only the running agents', () => {
    const m = new Map<string, SessionStatus>([
      ['a', 'running'],
      ['b', 'idle'],
      ['c', 'running'],
      ['d', 'done'],
      ['e', 'error'],
    ]);
    expect(countRunning(m)).toBe(2);
  });
  it('is 0 for an empty map', () => {
    expect(countRunning(new Map())).toBe(0);
  });
});

describe('status presentation', () => {
  it('pulses for the statuses that are DOING something', () => {
    const pulsing: SessionStatus[] = ['running', 'starting'];
    for (const s of ALL) expect(statusPulses(s)).toBe(pulsing.includes(s));
  });
  it('has a non-empty label + valid hex colour for every status', () => {
    for (const s of ALL) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
  it('relabels running→active and idle→ready', () => {
    expect(STATUS_LABEL.running).toBe('active');
    expect(STATUS_LABEL.idle).toBe('ready');
  });
  it('names what a parked session wants, rather than a generic "blocked"', () => {
    expect(STATUS_LABEL.awaiting_approval).toBe('approval');
    expect(STATUS_LABEL.awaiting_input).toBe('question');
  });
  it('keeps acid reserved for running — the one live thing', () => {
    const acid = STATUS_COLOR.running;
    for (const s of ALL.filter((x) => x !== 'running')) expect(STATUS_COLOR[s]).not.toBe(acid);
  });
});

describe('status predicates', () => {
  it('flags exactly the two parked states as needing attention', () => {
    const blocked: SessionStatus[] = ['awaiting_approval', 'awaiting_input'];
    for (const s of ALL) expect(statusNeedsAttention(s)).toBe(blocked.includes(s));
  });
  it('counts a parked session as busy — its claude process is still alive', () => {
    const busy: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input'];
    for (const s of ALL) expect(isBusyStatus(s)).toBe(busy.includes(s));
  });
  it('treats only done/error as terminal', () => {
    const terminal: SessionStatus[] = ['done', 'error'];
    for (const s of ALL) expect(isTerminalStatus(s)).toBe(terminal.includes(s));
  });
  it('partitions every status into busy | terminal | idle, with no overlap', () => {
    for (const s of ALL) {
      expect(Number(isBusyStatus(s)) + Number(isTerminalStatus(s)) + Number(s === 'idle')).toBe(1);
    }
  });
  it('never pulses and demands attention at the same time', () => {
    for (const s of ALL) expect(statusPulses(s) && statusNeedsAttention(s)).toBe(false);
  });
});

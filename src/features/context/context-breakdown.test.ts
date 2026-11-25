import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../contract/common';
import type { ContextBreakdown, ContextBreakdownResponse, ContextCategory, ContextMcpTool } from '../../../contract/token-viewer';
import {
  barSegments,
  breakdownView,
  categoryKey,
  categoryTone,
  footerCopy,
  groupMcpTools,
  headerParts,
  isTurnLive,
  mergeResponse,
  orderRows,
  pathLeaf,
  shareLabel,
  tokenLabel,
  toolLabel,
  turnEnded,
  updatedAgo,
} from './context-breakdown';

const cat = (id: string | null, tokens: number, kind: ContextCategory['kind'] = 'used', name = id ?? 'Other'): ContextCategory => ({
  id,
  name,
  tokens,
  kind,
});

// Shaped after src-tauri/src/session/stream/fixtures/context-usage-resumed.ndjson.
const CATEGORIES: ContextCategory[] = [
  cat('system_prompt', 4071),
  cat('system_tools', 6552),
  cat('mcp_tools', 686),
  cat('mcp_instructions', 2283),
  cat('mcp_tools_deferred', 46667, 'deferred'),
  cat('system_tools_deferred', 15275, 'deferred'),
  cat('custom_agents', 4328),
  cat('memory_files', 19507),
  cat('skills', 9946),
  cat('messages', 46171),
  cat('autocompact_buffer', 33000, 'buffer'),
  cat('free_space', 873456, 'free'),
];

const BREAKDOWN: ContextBreakdown = {
  model: 'claude-fable-5-2',
  totalTokens: 93544,
  maxTokens: 1_000_000,
  percentage: 9,
  categories: CATEGORIES,
  mcpTools: [],
  memoryFiles: [],
  agents: [],
  skills: [],
  autoCompactThreshold: 967000,
};

describe('tokenLabel', () => {
  it('reads compact: 123.8K, 1M, 85', () => {
    expect(tokenLabel(123_800)).toBe('123.8K');
    expect(tokenLabel(1_000_000)).toBe('1M');
    expect(tokenLabel(85)).toBe('85');
    expect(tokenLabel(191_500)).toBe('191.5K');
  });
});

describe('shareLabel', () => {
  it('is tokens / window as x.y%', () => {
    expect(shareLabel(cat('messages', 123_800), 1_000_000)).toBe('12.4%');
    expect(shareLabel(cat('system_tools', 23_100), 1_000_000)).toBe('2.3%');
    expect(shareLabel(cat('skills', 0), 200_000)).toBe('0.0%');
  });

  it('is an em dash for a deferred row — it is not in the window', () => {
    expect(shareLabel(cat('mcp_tools_deferred', 117_400, 'deferred'), 1_000_000)).toBe('—');
  });

  it('never divides by a non-positive window', () => {
    expect(shareLabel(cat('messages', 10), 0)).toBe('—');
  });
});

describe('orderRows', () => {
  it('sorts in-window rows by tokens desc, then buffer and free, then deferred', () => {
    const { used, reserve, deferred } = orderRows(CATEGORIES);
    expect(used.map((r) => r.id)).toEqual([
      'messages',
      'memory_files',
      'skills',
      'system_tools',
      'custom_agents',
      'system_prompt',
      'mcp_instructions',
      'mcp_tools',
    ]);
    expect(reserve.map((r) => r.id)).toEqual(['autocompact_buffer', 'free_space']);
    expect(deferred.map((r) => r.id)).toEqual(['mcp_tools_deferred', 'system_tools_deferred']);
  });

  it('keeps buffer before free whatever the CLI order', () => {
    const { reserve } = orderRows([cat('free_space', 5, 'free'), cat('autocompact_buffer', 9, 'buffer')]);
    expect(reserve.map((r) => r.kind)).toEqual(['buffer', 'free']);
  });

  it('sorts deferred rows by tokens desc too', () => {
    const { deferred } = orderRows([cat('a', 1, 'deferred'), cat('b', 9, 'deferred')]);
    expect(deferred.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const input = [cat('a', 1), cat('b', 9)];
    orderRows(input);
    expect(input.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('in-window + buffer + free sum to the window for the fixture', () => {
    const { used, reserve } = orderRows(CATEGORIES);
    const sum = [...used, ...reserve].reduce((n, r) => n + r.tokens, 0);
    expect(sum).toBe(BREAKDOWN.maxTokens);
  });
});

describe('categoryTone', () => {
  it('maps the known ids to their category colour', () => {
    expect(categoryTone(cat('messages', 1))).toBe('messages');
    expect(categoryTone(cat('system_tools', 1))).toBe('system-tools');
    expect(categoryTone(cat('mcp_tools', 1))).toBe('mcp-tools');
    expect(categoryTone(cat('system_prompt', 1))).toBe('system-prompt');
    for (const id of ['skills', 'custom_agents', 'memory_files', 'mcp_instructions']) {
      expect(categoryTone(cat(id, 1))).toBe('quiet');
    }
  });

  it('reads buffer, free and deferred off the kind, not the id', () => {
    expect(categoryTone(cat('autocompact_buffer', 1, 'buffer'))).toBe('buffer');
    expect(categoryTone(cat('free_space', 1, 'free'))).toBe('free');
    expect(categoryTone(cat('mcp_tools_deferred', 1, 'deferred'))).toBe('deferred');
    expect(categoryTone(cat('messages', 1, 'deferred'))).toBe('deferred');
  });

  it('falls back to neutral for an unknown or missing id', () => {
    expect(categoryTone(cat('brand_new_thing', 1))).toBe('neutral');
    expect(categoryTone(cat(null, 1))).toBe('neutral');
  });
});

describe('categoryKey', () => {
  it('keys on the id, falling back to kind + name when the CLI sent none', () => {
    expect(categoryKey(cat('messages', 1))).toBe('messages');
    expect(categoryKey(cat(null, 1, 'used', 'Mystery'))).toBe('used:Mystery');
  });
});

describe('barSegments', () => {
  it('is one segment per in-window row (ordered) plus the buffer, as % of the window; free is the track', () => {
    const segs = barSegments(BREAKDOWN);
    expect(segs.map((s) => s.key)).toEqual([
      'messages',
      'memory_files',
      'skills',
      'system_tools',
      'custom_agents',
      'system_prompt',
      'mcp_instructions',
      'mcp_tools',
      'autocompact_buffer',
    ]);
    expect(segs[0]).toMatchObject({ tone: 'messages' });
    expect(segs[0].percent).toBeCloseTo(4.6171, 4);
    expect(segs[segs.length - 1]).toMatchObject({ tone: 'buffer' });
    expect(segs[segs.length - 1].percent).toBeCloseTo(3.3, 4);
  });

  it('drops zero-token rows and clamps the running total at 100%', () => {
    const segs = barSegments({
      ...BREAKDOWN,
      maxTokens: 100,
      categories: [cat('messages', 80), cat('skills', 0), cat('system_tools', 40), cat('autocompact_buffer', 10, 'buffer')],
    });
    expect(segs.map((s) => [s.key, s.percent])).toEqual([
      ['messages', 80],
      ['system_tools', 20],
    ]);
  });
});

describe('headerParts', () => {
  it("uses the CLI's own percentage and a compact used / window figure", () => {
    expect(headerParts({ ...BREAKDOWN, totalTokens: 191_500, percentage: 19 })).toEqual({
      used: '19% used',
      figure: '191.5K / 1M',
    });
  });
});

describe('groupMcpTools', () => {
  const tool = (serverName: string, name: string, tokens: number, isLoaded: boolean | null = true): ContextMcpTool => ({
    name,
    serverName,
    tokens,
    isLoaded,
  });

  it('groups by server with per-server totals, biggest server first, tools by tokens desc', () => {
    const groups = groupMcpTools([
      tool('cartograph', 'mcp__cartograph__map', 138, false),
      tool('linear', 'mcp__linear__list', 50),
      tool('cartograph', 'mcp__cartograph__concept', 490, false),
      tool('linear', 'mcp__linear__get', 70, null),
    ]);
    expect(groups.map((g) => [g.server, g.tokens])).toEqual([
      ['cartograph', 628],
      ['linear', 120],
    ]);
    expect(groups[0].tools.map((t) => t.name)).toEqual(['mcp__cartograph__concept', 'mcp__cartograph__map']);
    expect(groups[1].tools.map((t) => t.name)).toEqual(['mcp__linear__get', 'mcp__linear__list']);
  });

  it('marks a tool deferred only when isLoaded is exactly false', () => {
    const [group] = groupMcpTools([tool('s', 'a', 3, false), tool('s', 'b', 2, null), tool('s', 'c', 1, true)]);
    expect(group.tools.map((t) => t.deferred)).toEqual([true, false, false]);
  });

  it('breaks token ties on server name for a stable order', () => {
    expect(groupMcpTools([tool('zeta', 'x', 5), tool('alpha', 'y', 5)]).map((g) => g.server)).toEqual(['alpha', 'zeta']);
  });

  it('is empty for no tools', () => {
    expect(groupMcpTools([])).toEqual([]);
  });
});

describe('toolLabel', () => {
  it("strips the mcp__<server>__ prefix — the group already names the server", () => {
    expect(toolLabel({ name: 'mcp__cartograph__map', serverName: 'cartograph' })).toBe('map');
  });

  it('keeps a name that does not carry the prefix verbatim', () => {
    expect(toolLabel({ name: 'search', serverName: 'cartograph' })).toBe('search');
  });
});

describe('pathLeaf', () => {
  it('takes the last segment of a Windows, POSIX or WSL path', () => {
    expect(pathLeaf('D:\\francois\\CLAUDE.md')).toBe('CLAUDE.md');
    expect(pathLeaf('/home/dev/.claude/CLAUDE.md')).toBe('CLAUDE.md');
    expect(pathLeaf('/mnt/c/work/MEMORY.md')).toBe('MEMORY.md');
  });
});

describe('isTurnLive / turnEnded', () => {
  it('counts starting, running and the two blocked states as a live turn', () => {
    for (const s of ['starting', 'running', 'awaiting_approval', 'awaiting_input'] as const) expect(isTurnLive(s)).toBe(true);
    for (const s of ['idle', 'done', 'error'] as const) expect(isTurnLive(s)).toBe(false);
  });

  it('fires when a live turn settles — idle, or ended in error/done (else a pending view would never refetch)', () => {
    expect(turnEnded('running', 'idle')).toBe(true);
    expect(turnEnded('awaiting_approval', 'idle')).toBe(true);
    expect(turnEnded('running', 'error')).toBe(true);
    expect(turnEnded('running', 'done')).toBe(true);
    expect(turnEnded('idle', 'idle')).toBe(false);
    expect(turnEnded('running', 'awaiting_input')).toBe(false);
    expect(turnEnded('error', 'idle')).toBe(false);
    expect(turnEnded(undefined, 'idle')).toBe(false);
  });

  it('never reads an id on the object prototype as a known category', () => {
    expect(categoryTone(cat('constructor', 1))).toBe('neutral');
    expect(categoryTone(cat('toString', 1))).toBe('neutral');
  });
});

describe('updatedAgo / footerCopy', () => {
  const NOW = 10_000_000;

  it('reads just now under a minute, then whole minutes, hours, days', () => {
    expect(updatedAgo(NOW - 59_000, NOW)).toBe('just now');
    expect(updatedAgo(NOW + 5_000, NOW)).toBe('just now'); // clock skew
    expect(updatedAgo(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(updatedAgo(NOW - 59 * 60_000, NOW)).toBe('59 min ago');
    expect(updatedAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago');
    expect(updatedAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 d ago');
  });

  it('says Measuring… while a probe is in flight', () => {
    expect(footerCopy({ loading: true, measuredAt: NOW, now: NOW, turnLive: false })).toBe('Measuring…');
  });

  it('says when it was measured, plus the refresh promise while a turn is live', () => {
    expect(footerCopy({ loading: false, measuredAt: NOW, now: NOW, turnLive: false })).toBe('Updated just now');
    expect(footerCopy({ loading: false, measuredAt: NOW - 180_000, now: NOW, turnLive: true })).toBe(
      'Updated 3 min ago · refreshes when this turn ends',
    );
  });

  it('is empty with nothing measured', () => {
    expect(footerCopy({ loading: false, measuredAt: null, now: NOW, turnLive: false })).toBe('');
  });
});

describe('mergeResponse', () => {
  const shown: ContextBreakdownResponse = { breakdown: BREAKDOWN, measuredAt: 5, stale: false };

  it('takes the new answer when it carries a breakdown', () => {
    const next = { breakdown: { ...BREAKDOWN, percentage: 12 }, measuredAt: 9, stale: false };
    expect(mergeResponse(shown, next)).toBe(next);
  });

  it('keeps the last good breakdown (marked stale) when the new answer has none', () => {
    expect(mergeResponse(shown, { breakdown: null, measuredAt: null, stale: true })).toEqual({ ...shown, stale: true });
  });

  it('takes an empty answer when there is nothing to keep', () => {
    const empty = { breakdown: null, measuredAt: null, stale: true };
    expect(mergeResponse(null, empty)).toBe(empty);
  });
});

describe('breakdownView', () => {
  const unavailable: AppError = { code: 'CONTEXT_BREAKDOWN_UNAVAILABLE', message: 'This Claude Code version cannot report a context breakdown — update Claude Code.' };
  const other: AppError = { code: 'INTERNAL', message: 'boom' };
  const shown: ContextBreakdownResponse = { breakdown: BREAKDOWN, measuredAt: 5, stale: false };
  const base = { supported: true, loading: false, data: null, error: null };

  it('is hidden on a runtime without a breakdown, whatever the state', () => {
    expect(breakdownView({ ...base, supported: false, data: shown })).toEqual({ kind: 'hidden' });
  });

  it('measures before the first answer lands', () => {
    expect(breakdownView({ ...base, loading: true })).toEqual({ kind: 'measuring' });
    expect(breakdownView(base)).toEqual({ kind: 'measuring' });
  });

  it('waits for the turn when the core had nothing to give during a live turn', () => {
    expect(breakdownView({ ...base, data: { breakdown: null, measuredAt: null, stale: true } })).toEqual({ kind: 'pending' });
  });

  it('is hidden when the breakdown is unavailable and none was ever loaded (legacy meter stays)', () => {
    expect(breakdownView({ ...base, error: unavailable })).toEqual({ kind: 'hidden' });
  });

  it('shows any other error, with no breakdown, as a message to retry', () => {
    expect(breakdownView({ ...base, error: other })).toEqual({ kind: 'error', message: 'boom' });
  });

  it('shows the breakdown, carrying an error below it when a later probe failed', () => {
    expect(breakdownView({ ...base, data: shown })).toEqual({ kind: 'shown', response: shown, error: null });
    expect(breakdownView({ ...base, data: shown, error: unavailable })).toEqual({
      kind: 'shown',
      response: shown,
      error: unavailable.message,
    });
  });
});

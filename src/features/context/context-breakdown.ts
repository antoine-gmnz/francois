// token-viewer — pure helpers for the Context tab's breakdown (specs/token-viewer.md
// FR-14/FR-16/FR-17). Every row is classified on `kind` and keyed on `id`, never
// on the CLI's English `name` (display only) or its own colour names.

import type { AppError, SessionStatus } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import type { ContextBreakdown, ContextBreakdownResponse, ContextCategory, ContextMcpTool } from '../../../contract/token-viewer';
import { basename } from '../../lib/path';

/** Compact token label — `123.8K`, `1M`, `85` — the context window's own formatter. */
export const tokenLabel = formatContextTokens;

/** Last segment of a memory file's path (host, POSIX or WSL). */
export const pathLeaf = basename;

const DASH = '—';

/** `12.4%` — locale-independent; a deferred row is not in the window, so `—`. */
export function shareLabel(row: ContextCategory, maxTokens: number): string {
  if (row.kind === 'deferred' || maxTokens <= 0) return DASH;
  return `${((row.tokens / maxTokens) * 100).toFixed(1)}%`;
}

const byTokensDesc = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens;

export interface OrderedRows {
  /** In-window categories, biggest first. */
  used: ContextCategory[];
  /** Autocompact buffer, then free space. */
  reserve: ContextCategory[];
  /** Out-of-window tool schemas, biggest first. */
  deferred: ContextCategory[];
}

export function orderRows(categories: ContextCategory[]): OrderedRows {
  const of = (kind: ContextCategory['kind']) => categories.filter((c) => c.kind === kind);
  return {
    used: of('used').sort(byTokensDesc),
    reserve: [...of('buffer'), ...of('free')],
    deferred: of('deferred').sort(byTokensDesc),
  };
}

export type CategoryTone =
  | 'messages'
  | 'system-tools'
  | 'mcp-tools'
  | 'system-prompt'
  | 'quiet'
  | 'buffer'
  | 'free'
  | 'deferred'
  | 'neutral';

const TONE_BY_ID: ReadonlyMap<string, CategoryTone> = new Map<string, CategoryTone>([
  ['messages', 'messages'],
  ['system_tools', 'system-tools'],
  ['mcp_tools', 'mcp-tools'],
  ['system_prompt', 'system-prompt'],
  ['skills', 'quiet'],
  ['custom_agents', 'quiet'],
  ['memory_files', 'quiet'],
  ['mcp_instructions', 'quiet'],
]);

/** The colour class modifier — §8's categorical mapping, neutral for an id this build has never seen. */
export function categoryTone(row: ContextCategory): CategoryTone {
  if (row.kind === 'buffer' || row.kind === 'free' || row.kind === 'deferred') return row.kind;
  return (row.id !== null && TONE_BY_ID.get(row.id)) || 'neutral';
}

/** React key: the id, or kind + name for an old CLI that sends none. */
export function categoryKey(row: ContextCategory): string {
  return row.id ?? `${row.kind}:${row.name}`;
}

export interface BarSegment {
  key: string;
  tone: CategoryTone;
  /** Share of the window, 0–100. */
  percent: number;
}

/** One segment per in-window row (ordered) plus the buffer; free space is the bar's track. */
export function barSegments(b: ContextBreakdown): BarSegment[] {
  if (b.maxTokens <= 0) return [];
  const { used, reserve } = orderRows(b.categories);
  const rows = [...used, ...reserve.filter((r) => r.kind === 'buffer')];
  const segments: BarSegment[] = [];
  let total = 0;
  for (const row of rows) {
    const percent = Math.min((row.tokens / b.maxTokens) * 100, 100 - total);
    if (percent <= 0) continue;
    total += percent;
    segments.push({ key: categoryKey(row), tone: categoryTone(row), percent });
  }
  return segments;
}

/** `19% used` (the CLI's own rounding) and `191.5K / 1M`. */
export function headerParts(b: ContextBreakdown): { used: string; figure: string } {
  return { used: `${b.percentage}% used`, figure: `${tokenLabel(b.totalTokens)} / ${tokenLabel(b.maxTokens)}` };
}

export interface McpToolRow {
  name: string;
  tokens: number;
  /** Schema not in the window — only `isLoaded === false` means this. */
  deferred: boolean;
}

export interface McpServerGroup {
  server: string;
  /** Every tool's tokens, loaded or deferred. */
  tokens: number;
  tools: McpToolRow[];
}

/** MCP tools grouped by server — biggest server first, tools biggest first. */
export function groupMcpTools(tools: ContextMcpTool[]): McpServerGroup[] {
  const groups = new Map<string, McpServerGroup>();
  for (const tool of tools) {
    const group = groups.get(tool.serverName) ?? { server: tool.serverName, tokens: 0, tools: [] };
    group.tokens += tool.tokens;
    group.tools.push({ name: tool.name, tokens: tool.tokens, deferred: tool.isLoaded === false });
    groups.set(tool.serverName, group);
  }
  const list = [...groups.values()];
  for (const g of list) g.tools.sort(byTokensDesc);
  return list.sort((a, b) => b.tokens - a.tokens || a.server.localeCompare(b.server));
}

/** `mcp__cartograph__map` → `map`: the group heading already names the server. */
export function toolLabel(tool: Pick<ContextMcpTool, 'name' | 'serverName'>): string {
  const prefix = `mcp__${tool.serverName}__`;
  return tool.name.startsWith(prefix) && tool.name.length > prefix.length ? tool.name.slice(prefix.length) : tool.name;
}

const LIVE: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'awaiting_approval', 'awaiting_input']);

/** A turn owns the session — the core will not probe (FR-3). */
export function isTurnLive(status: SessionStatus): boolean {
  return LIVE.has(status);
}

/** FR-13: a live turn settling (idle, or ended in error/done) is the cue to refetch. */
export function turnEnded(prev: SessionStatus | undefined, next: SessionStatus): boolean {
  return prev !== undefined && isTurnLive(prev) && !isTurnLive(next);
}

/** `just now` · `3 min ago` · `2 h ago` · `3 d ago`. */
export function updatedAgo(measuredAt: number, now: number): string {
  const min = Math.floor((now - measuredAt) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

export function footerCopy(o: { loading: boolean; measuredAt: number | null; now: number; turnLive: boolean }): string {
  if (o.loading) return 'Measuring…';
  if (o.measuredAt === null) return '';
  return `Updated ${updatedAgo(o.measuredAt, o.now)}${o.turnLive ? ' · refreshes when this turn ends' : ''}`;
}

/** A later answer without a breakdown (turn live, nothing cached) never erases the last good one. */
export function mergeResponse(prev: ContextBreakdownResponse | null, next: ContextBreakdownResponse): ContextBreakdownResponse {
  if (next.breakdown === null && prev?.breakdown) return { ...prev, stale: true };
  return next;
}

export type BreakdownView =
  | { kind: 'hidden' }
  | { kind: 'measuring' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string }
  | { kind: 'shown'; response: ContextBreakdownResponse & { breakdown: ContextBreakdown }; error: string | null };

/** What the Context tab renders (FR-15/16/17). Only `shown` hides the footer MeterRow. */
export function breakdownView(s: {
  supported: boolean;
  loading: boolean;
  data: ContextBreakdownResponse | null;
  error: AppError | null;
}): BreakdownView {
  if (!s.supported) return { kind: 'hidden' };
  const data = s.data;
  if (data?.breakdown) return { kind: 'shown', response: { ...data, breakdown: data.breakdown }, error: s.error?.message ?? null };
  if (s.error) return s.error.code === 'CONTEXT_BREAKDOWN_UNAVAILABLE' ? { kind: 'hidden' } : { kind: 'error', message: s.error.message };
  if (data && !s.loading) return { kind: 'pending' };
  return { kind: 'measuring' };
}

// design 9a — the transcript reads as TURNS. Before this, every block was its
// own row with its own glyph, so a reply that ran three tools looked like five
// unrelated lines. A turn is one gutter glyph, one header stating who spoke and
// what the reply cost, and one content column holding the prose and the tool
// rail together.
//
// Pure grouping + derivation only, so the rules are testable without the DOM.
// Runs AFTER compactBlocks (conversation-blocks.ts) and replaces groupToolRuns
// as the transcript's render-item builder.

import type { ConversationBlock } from '../../../contract/conversation-view';

/** The four block kinds that belong INSIDE a turn — everything else is a card. */
export type TurnBlock = Extract<ConversationBlock, { kind: 'user' | 'assistant' | 'tool' | 'subagent' }>;

export type TurnRole = 'user' | 'assistant';

export interface TranscriptTurn {
  kind: 'turn';
  /** The lead block's id — stable across re-renders, so it keys the row. */
  turnId: string;
  role: TurnRole;
  blocks: TurnBlock[];
}

/**
 * A block that renders its own chrome at transcript level rather than inside a
 * turn: approval cards, question cards, slash-command output. 9a draws these
 * full width, as siblings of the turn grid — a permission ask is the transcript
 * stopping, not a paragraph of a reply.
 */
export interface TranscriptCard {
  kind: 'card';
  block: Exclude<ConversationBlock, TurnBlock>;
}

export type TranscriptItem = TranscriptTurn | TranscriptCard;

function isTurnBlock(b: ConversationBlock): b is TurnBlock {
  return b.kind === 'user' || b.kind === 'assistant' || b.kind === 'tool' || b.kind === 'subagent';
}

/**
 * Fold a block list into turns.
 *
 *  - a `user` block always opens its OWN turn: two prompts in a row are two
 *    turns, because each carries its own clock and the reader sent them at
 *    different moments.
 *  - `assistant` / `tool` / `subagent` extend the open reply, or open one — a
 *    tool call that arrived before any prose (a reply that went straight to
 *    work) leads its own turn rather than floating loose.
 *  - a card closes whatever turn is open and stands alone. It has to: the card
 *    renders at transcript level, so it cannot sit inside the turn's content
 *    column, and anything after it is a genuinely separate stretch of work.
 */
export function groupTurns(blocks: ConversationBlock[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let open: TranscriptTurn | null = null;
  for (const b of blocks) {
    if (!isTurnBlock(b)) {
      open = null;
      out.push({ kind: 'card', block: b });
      continue;
    }
    const role: TurnRole = b.kind === 'user' ? 'user' : 'assistant';
    if (open !== null && open.role === role && role === 'assistant') {
      open.blocks.push(b);
      continue;
    }
    open = { kind: 'turn', turnId: b.blockId, role, blocks: [b] };
    out.push(open);
  }
  return out;
}

// ---------- header derivation (9a: `Francois · sonnet 4.7 · 3 steps · 1m 52s`) ----------

/** A "step" is work the reply did — a tool call or a dispatch, never prose. */
export function turnStepCount(turn: TranscriptTurn): number {
  return turn.blocks.filter((b) => b.kind === 'tool' || b.kind === 'subagent').length;
}

/**
 * When the turn began: the first block that carries a time. `at` is optional in
 * the contract (a transcript written before timestamps existed has none), so a
 * turn can legitimately have no start — and then it states no clock at all
 * rather than inventing one.
 */
export function turnStartedAt(turn: TranscriptTurn): number | null {
  for (const b of turn.blocks) {
    if (b.at !== undefined) return b.at;
  }
  return null;
}

/** When the turn last did something: the last block that carries a time. */
export function turnEndedAt(turn: TranscriptTurn): number | null {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const at = turn.blocks[i]!.at;
    if (at !== undefined) return at;
  }
  return null;
}

/**
 * How long the turn ran. A turn still streaming runs to `now` (the caller ticks
 * it), a finished one to its last block. Clamped at 0 — a clock that stepped
 * backwards between two blocks must not read as a negative duration.
 */
export function turnSpanMs(turn: TranscriptTurn, now: number): number | null {
  const start = turnStartedAt(turn);
  if (start === null) return null;
  const streaming = turn.blocks.some((b) => b.isStreaming);
  const end = streaming ? now : (turnEndedAt(turn) ?? start);
  return Math.max(0, end - start);
}

/**
 * The right-hand side of the header row: `3 steps · 1m 52s`. Each half is
 * dropped when it cannot be claimed — a prompt has no steps, an untimed turn
 * has no duration, and a turn with neither states nothing.
 */
export function turnMeta(turn: TranscriptTurn, now: number): string {
  // A prompt is one block: its span is always zero, and `0s` beside a message
  // the reader just typed states nothing. The user turn's right-hand slot is
  // the clock (formatClock), which the header renders instead.
  if (turn.role === 'user') return '';
  const parts: string[] = [];
  const steps = turnStepCount(turn);
  if (steps > 0) parts.push(steps === 1 ? '1 step' : `${steps} steps`);
  const span = turnSpanMs(turn, now);
  if (span !== null) parts.push(formatTurnDuration(span));
  return parts.join(' · ');
}

/** 9a: the prompt is stamped with a zero-padded 24h local wall clock. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `1m 52s` — the largest two non-zero units, dropping a zero remainder so a
 * round two minutes reads `2m` rather than `2m 0s`. Sub-second rounds down to
 * `0s`: a reply that landed instantly took no measurable time, and `0.9s` is
 * more precision than the header is claiming.
 */
export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  if (m > 0) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  return `${s}s`;
}

// ---------- tool rows (9a: the result is chips, not a trailing sentence) ----------

export type ToolChipTone = 'add' | 'del' | 'error' | 'plain';

export interface ToolChip {
  tone: ToolChipTone;
  text: string;
}

/** The core's edit/multi-edit meta — `+88 −140`, U+2212 minus (tools.rs). */
const LINE_CHANGE_META = /^\+(\d+)\s+[−-](\d+)$/;

/**
 * Turn a tool block's `meta` into the row's right-hand chips.
 *
 * Only the line-change meta fans out, into a green added chip and a red removed
 * one — that is the shape 9a draws, and the only meta whose two halves mean
 * different things. Everything else stays ONE chip: `7 matches · 3 files` is a
 * single sentence about a single result, and splitting it on the separator
 * would make the row look like two unrelated outcomes.
 */
export function toolResultChips(meta: string | undefined): ToolChip[] {
  if (meta === undefined || meta === '') return [];
  const change = LINE_CHANGE_META.exec(meta);
  if (change !== null) {
    return [
      { tone: 'add', text: `+${change[1]}` },
      // Normalized to the core's U+2212, so an ASCII minus never renders at a
      // different width from the added chip beside it.
      { tone: 'del', text: `−${change[2]}` },
    ];
  }
  const tone: ToolChipTone = /\b(error|failed|failure)\b/i.test(meta) ? 'error' : 'plain';
  return [{ tone, text: meta }];
}

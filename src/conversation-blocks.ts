// Transcript block apply rules for the SESSION tab (conversation-view FR-10 +
// interactive-commands FR-20/21). Pure logic — extracted from ConversationView
// so the keyed idempotent upserts are unit-testable without the DOM.
//
// Every rule is a keyed upsert on blockId: replaying an event is a no-op or an
// identical replace, and out-of-order arrivals insert rather than drop.

import type { CommandCard, PermissionAsk, PermissionRule, Result, SessionQuestion } from '../contract/common';
import {
  assistantColors,
  classifyToolStart,
  type ConversationBlock,
  type ToolConversationBlock,
  type UserConversationBlock,
} from '../contract/conversation-view';
import type { CommandConversationBlock } from '../contract/interactive-commands';
import type { PermissionConversationBlock } from '../contract/permission-guardrails';
import type { QuestionConversationBlock } from '../contract/session-questions';

export interface TranscriptState {
  blocks: ConversationBlock[];
}

export type TranscriptAction =
  | { t: 'seed'; blocks: ConversationBlock[] }
  | { t: 'optimisticUser'; blockId: string; text: string }
  | { t: 'msgUser'; blockId: string; text: string }
  | { t: 'delta'; blockId: string; text: string }
  | { t: 'assistantDone'; blockId: string }
  | { t: 'toolStart'; blockId: string; tool: string; summary: string }
  | { t: 'toolDone'; blockId: string; meta: string }
  | { t: 'commandStarted'; blockId: string; command: string } // interactive-commands FR-20
  | { t: 'commandOutput'; blockId: string; card: CommandCard } // interactive-commands FR-20
  | { t: 'questionAsked'; blockId: string; questions: SessionQuestion[] } // session-questions FR-16
  | { t: 'questionResolved'; blockId: string; state: 'answered' | 'cancelled'; answers?: Record<string, string> } // session-questions FR-16
  | { t: 'permissionAsked'; blockId: string; ask: PermissionAsk } // permission-guardrails FR-24
  | { t: 'permissionResolved'; blockId: string; state: 'allowed' | 'denied' | 'cancelled'; rule?: PermissionRule } // permission-guardrails FR-24
  | { t: 'clear' } // /clear: full reset — drop every block
  | { t: 'remove'; blockId: string };

/** True iff `text` is exactly the bare `/clear` command (no argument). */
export function isClearCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

/** Command token (without '/') a card answers — for insert-if-unseen outputs. */
export function commandFromCard(card: CommandCard): string {
  switch (card.kind) {
    case 'usage':
    case 'text':
      return card.command;
    case 'context':
      return 'context';
    case 'model':
      return 'model';
    case 'status':
      return 'status';
    case 'help':
      return 'help';
    case 'notice':
      return ''; // notices carry no command token
  }
}

/**
 * §8 header label: card-derived command, else the block's command token, else
 * 'OUTPUT' (a text card for unparsed input carries command: '' — the header
 * must never render empty). Uppercased for the card header row.
 */
export function cardHeaderLabel(card: CommandCard | undefined, blockCommand: string): string {
  const token = (card && commandFromCard(card)) || blockCommand;
  return (token || 'output').toUpperCase();
}

/**
 * FR-24: the placeholder a resolved-before-asked permission block carries until
 * its `permission.asked` arrives. Every field empty so the card renders inert
 * chrome rather than misleading content, and so the fill-in check is unambiguous.
 */
const EMPTY_ASK: PermissionAsk = {
  toolName: '',
  summary: '',
  inputJson: '',
  cwd: '',
  pattern: '',
  patternLabel: '',
};

export function transcriptReducer(state: TranscriptState, a: TranscriptAction): TranscriptState {
  const idx = (id: string) => state.blocks.findIndex((b) => b.blockId === id);
  const replace = (i: number, b: ConversationBlock) => {
    const next = state.blocks.slice();
    next[i] = b;
    return { blocks: next };
  };
  switch (a.t) {
    case 'seed':
      return { blocks: a.blocks };
    case 'optimisticUser': {
      if (idx(a.blockId) !== -1) return state;
      const b: UserConversationBlock = { kind: 'user', blockId: a.blockId, isStreaming: false, text: a.text, queued: true };
      return { blocks: [...state.blocks, b] };
    }
    case 'msgUser': {
      const i = idx(a.blockId);
      if (i !== -1) {
        const b = state.blocks[i];
        if (b.kind !== 'user') return state;
        return replace(i, { ...b, text: a.text, queued: false });
      }
      const b: UserConversationBlock = { kind: 'user', blockId: a.blockId, isStreaming: false, text: a.text, queued: false };
      return { blocks: [...state.blocks, b] };
    }
    case 'delta': {
      const i = idx(a.blockId);
      if (i !== -1) {
        const b = state.blocks[i];
        if (b.kind !== 'assistant') return state;
        return replace(i, { ...b, text: b.text + a.text });
      }
      const { glyphColor, bodyColor } = assistantColors(true);
      return {
        blocks: [
          ...state.blocks,
          { kind: 'assistant', blockId: a.blockId, isStreaming: true, glyph: '●', glyphColor, bodyColor, text: a.text },
        ],
      };
    }
    case 'assistantDone': {
      const i = idx(a.blockId);
      if (i === -1) return state;
      const b = state.blocks[i];
      if (b.kind !== 'assistant') return state;
      const { glyphColor, bodyColor } = assistantColors(false);
      return replace(i, { ...b, isStreaming: false, glyphColor, bodyColor });
    }
    case 'toolStart': {
      if (idx(a.blockId) !== -1) return state;
      return { blocks: [...state.blocks, classifyToolStart(a.tool, a.summary, a.blockId)] };
    }
    case 'toolDone': {
      const i = idx(a.blockId);
      if (i === -1) return state;
      const b = state.blocks[i];
      if (b.kind !== 'tool' && b.kind !== 'subagent') return state;
      return replace(i, { ...b, meta: a.meta, isStreaming: false });
    }
    case 'commandStarted': {
      // FR-20: insert a pending command block (loading card); replay is a no-op.
      if (idx(a.blockId) !== -1) return state;
      const b: CommandConversationBlock = { kind: 'command', blockId: a.blockId, isStreaming: true, command: a.command };
      return { blocks: [...state.blocks, b] };
    }
    case 'commandOutput': {
      // FR-20: upsert the card; insert if unseen (instant notices arrive without
      // a command.started — FR-11/FR-13 — and so do synthetic detections).
      const i = idx(a.blockId);
      if (i === -1) {
        const b: CommandConversationBlock = {
          kind: 'command',
          blockId: a.blockId,
          isStreaming: false,
          command: commandFromCard(a.card),
          card: a.card,
        };
        return { blocks: [...state.blocks, b] };
      }
      const b = state.blocks[i];
      if (b.kind !== 'command') return state;
      return replace(i, { ...b, card: a.card, isStreaming: false });
    }
    case 'questionAsked': {
      // FR-16: keyed idempotent insert; replay is a no-op. The one upsert case:
      // a resolved-first block (out-of-order insert, questions: []) gets its
      // verbatim questions filled in without reviving its resolution.
      const i = idx(a.blockId);
      if (i === -1) {
        const b: QuestionConversationBlock = {
          kind: 'question',
          blockId: a.blockId,
          isStreaming: true, // FR-15: true iff pending
          questions: a.questions,
          state: 'pending',
        };
        return { blocks: [...state.blocks, b] };
      }
      const b = state.blocks[i];
      if (b.kind !== 'question') return state;
      if (b.questions.length === 0 && a.questions.length > 0) {
        return replace(i, { ...b, questions: a.questions });
      }
      return state;
    }
    case 'questionResolved': {
      // FR-16: update state/answers in place; resolve arriving before the
      // insert (out-of-order) inserts the resolved block (questions fill in
      // later via questionAsked). answers present iff answered (§5.2).
      const i = idx(a.blockId);
      if (i === -1) {
        const b: QuestionConversationBlock = {
          kind: 'question',
          blockId: a.blockId,
          isStreaming: false,
          questions: [],
          state: a.state,
          ...(a.answers !== undefined ? { answers: a.answers } : {}),
        };
        return { blocks: [...state.blocks, b] };
      }
      const b = state.blocks[i];
      if (b.kind !== 'question') return state;
      const next: QuestionConversationBlock = {
        kind: 'question',
        blockId: b.blockId,
        isStreaming: false,
        questions: b.questions,
        state: a.state,
        ...(a.answers !== undefined ? { answers: a.answers } : {}),
      };
      return replace(i, next);
    }
    case 'permissionAsked': {
      // FR-24: keyed idempotent insert; replay is a no-op. The one upsert case
      // mirrors questionAsked — a resolved-first block (out-of-order insert,
      // placeholder ask) gets its real ask filled in without reviving its
      // resolution.
      const i = idx(a.blockId);
      if (i === -1) {
        const b: PermissionConversationBlock = {
          kind: 'permission',
          blockId: a.blockId,
          isStreaming: true, // FR-25: true iff pending
          ask: a.ask,
          state: 'pending',
        };
        return { blocks: [...state.blocks, b] };
      }
      const b = state.blocks[i];
      if (b.kind !== 'permission') return state;
      if (b.ask.toolName === '' && a.ask.toolName !== '') {
        return replace(i, { ...b, ask: a.ask });
      }
      return state;
    }
    case 'permissionResolved': {
      // FR-24: update state/rule in place; a resolve arriving before the insert
      // (out-of-order) inserts the resolved block with a placeholder ask, which
      // a later permissionAsked fills in. `rule` present iff one was written.
      const i = idx(a.blockId);
      if (i === -1) {
        const b: PermissionConversationBlock = {
          kind: 'permission',
          blockId: a.blockId,
          isStreaming: false,
          ask: EMPTY_ASK,
          state: a.state,
          ...(a.rule !== undefined ? { rule: a.rule } : {}),
        };
        return { blocks: [...state.blocks, b] };
      }
      const b = state.blocks[i];
      if (b.kind !== 'permission') return state;
      const next: PermissionConversationBlock = {
        kind: 'permission',
        blockId: b.blockId,
        isStreaming: false,
        ask: b.ask,
        state: a.state,
        ...(a.rule !== undefined ? { rule: a.rule } : {}),
      };
      return replace(i, next);
    }
    case 'clear':
      return { blocks: [] };
    case 'remove': {
      const i = idx(a.blockId);
      if (i === -1) return state;
      const next = state.blocks.slice();
      next.splice(i, 1);
      return { blocks: next };
    }
  }
}

// ---------- render-time compaction of duplicate tool rows ----------

/** The core's tool_meta line-change shape: `+N −M` (U+2212 minus). */
const LINE_CHANGE_META = /^\+(\d+) −(\d+)$/;

/**
 * Collapse runs of consecutive tool blocks that are identical except for their
 * meta (e.g. repeated `Edit  src/a.ts` rows) into one row. Line-change metas
 * (`+N −M`) sum across the run; other metas keep the newest value. Render-time
 * only — reducer state stays one block per event so blockId-keyed upserts
 * (toolDone replay, out-of-order arrivals) are untouched.
 *
 * The newest block represents the run: its blockId keys the row and its
 * streaming state wins (a still-streaming edit shows the run total so far).
 * An `error` meta never merges — it stays its own visible row and breaks the
 * run on both sides.
 */
export function compactBlocks(blocks: ConversationBlock[]): ConversationBlock[] {
  const out: ConversationBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      b.kind === 'tool' &&
      prev !== undefined &&
      prev.kind === 'tool' &&
      prev.tool === b.tool &&
      prev.summary === b.summary &&
      prev.meta !== 'error' &&
      b.meta !== 'error'
    ) {
      out[out.length - 1] = mergeToolRun(prev, b);
      continue;
    }
    out.push(b);
  }
  return out;
}

function mergeToolRun(acc: ToolConversationBlock, b: ToolConversationBlock): ToolConversationBlock {
  const am = acc.meta !== undefined ? LINE_CHANGE_META.exec(acc.meta) : null;
  const bm = b.meta !== undefined ? LINE_CHANGE_META.exec(b.meta) : null;
  const meta =
    am && bm
      ? `+${Number(am[1]) + Number(bm[1])} −${Number(am[2]) + Number(bm[2])}`
      : (b.meta ?? acc.meta);
  return meta !== undefined ? { ...b, meta } : { ...b };
}

// ---------- model card helpers (interactive-commands FR-21) ----------

/**
 * The model card's current marker derives LIVE from the store's
 * SessionMeta.model.id — never from the card's currentId snapshot. The snapshot
 * is only the fallback when the session no longer exists in the store.
 */
export function liveCurrentModelId(storeModelId: string | undefined, snapshotId: string): string {
  return storeModelId ?? snapshotId;
}

/** §8: usage meter fill — gold below 80%, error red at ≥ 80%. */
export function meterFillColor(percentUsed: number): string {
  return percentUsed >= 80 ? 'var(--error)' : 'var(--accent)';
}

export interface ModelSwitchArgs {
  /** Session status is done/error → rows are non-interactive. */
  disabled: boolean;
  /** Live current model id (liveCurrentModelId) — clicking it is a no-op. */
  currentId: string;
  /** The clicked row's model id. */
  modelId: string;
  switchModel: (modelId: string) => Promise<Result<unknown>>;
  /** Card-local transient error line (null clears it). */
  setError: (message: string | null) => void;
  /** Timer injection point (setTimeout in the component, fake in tests). */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * FR-21 click flow: no-op on the current row or a disabled card; otherwise
 * clear any stale inline error, invoke francois:session:switchModel and, on
 * ok: false or a transport-level rejection, show the failure message inline
 * for 4 seconds. The marker itself moves via session.meta.
 */
export async function switchModelFromCard(a: ModelSwitchArgs): Promise<void> {
  if (a.disabled || a.modelId === a.currentId) return;
  // Clear any stale transient error from a prior attempt so it never survives
  // a subsequent successful switch inside the 4s window.
  a.setError(null);
  let failure: string | null = null;
  try {
    const res = await a.switchModel(a.modelId);
    if (!res.ok) failure = res.error.message;
  } catch (e) {
    // Transport-level rejection (the invoke bridge itself failed) — same
    // inline-error treatment as a domain ok: false.
    failure = e instanceof Error ? e.message : String(e);
  }
  if (failure !== null) {
    a.setError(failure);
    a.schedule(() => a.setError(null), 4000);
  }
}

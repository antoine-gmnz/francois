// Transcript block apply rules for the SESSION tab (conversation-view FR-10 +
// interactive-commands FR-20/21). Pure logic — extracted from ConversationView
// so the keyed idempotent upserts are unit-testable without the DOM.
//
// Every rule is a keyed upsert on blockId: replaying an event is a no-op or an
// identical replace, and out-of-order arrivals insert rather than drop.

import type { CommandCard, PermissionAsk, PermissionRule, Result, SessionEvent, SessionQuestion, SessionStatus, SlashCommandInfo } from '../../../contract/common';
import {
  assistantColors,
  classifyToolStart,
  type ConversationBlock,
  type ToolConversationBlock,
  type UserConversationBlock,
} from '../../../contract/conversation-view';
import type { CommandConversationBlock } from '../../../contract/interactive-commands';
import type { PermissionConversationBlock } from '../../../contract/permission-guardrails';
import type { QuestionConversationBlock } from '../../../contract/session-questions';

// mac-text-selection FR-1: the transcript container overrides the app-wide
// `body { user-select: none }` chrome rule (styles.css) so transcript CONTENT
// stays selectable/copyable. WKWebView (macOS's Tauri webview engine) has a
// documented history of silently ignoring the unprefixed `user-select`
// property for drag-to-select — Windows (WebView2) and Linux (WebKitGTK)
// already honor it unprefixed, so the -webkit- form is additive, not a
// replacement. Exported (rather than inlined in ConversationView's JSX) so
// the fix is unit-testable without a DOM environment.
export const TRANSCRIPT_TEXT_SELECT_STYLE: { userSelect: 'text'; WebkitUserSelect: 'text' } = {
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

export interface TranscriptState {
  blocks: ConversationBlock[];
}

export type TranscriptAction =
  | { t: 'seed'; blocks: ConversationBlock[] }
  | { t: 'optimisticUser'; blockId: string; text: string }
  | { t: 'msgUser'; blockId: string; text: string }
  | { t: 'delta'; blockId: string; text: string; offset: number }
  | { t: 'assistantDone'; blockId: string; text: string }
  | { t: 'toolStart'; blockId: string; tool: string; summary: string; model?: string }
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

type CardOfKind<K extends CommandCard['kind']> = Extract<CommandCard, { kind: K }>;

/**
 * Per-kind command-token derivation (§8 header label, via `cardHeaderLabel`
 * below). The single home for `CommandCard['kind']` discriminant knowledge —
 * `CommandCard.tsx`'s body-renderer table is typed against this table's keys
 * so the two enumerations can't drift apart (interactive-commands §8).
 */
export const CARD_KIND_COMMAND: { [K in CommandCard['kind']]: (card: CardOfKind<K>) => string } = {
  usage: (card) => card.command,
  text: (card) => card.command,
  context: () => 'context',
  model: () => 'model',
  status: () => 'status',
  help: () => 'help',
  notice: () => '', // notices carry no command token
};

/** Command token (without '/') a card answers — for insert-if-unseen outputs. */
export function commandFromCard(card: CommandCard): string {
  const derive = CARD_KIND_COMMAND[card.kind] as (card: CommandCard) => string;
  return derive(card);
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

/**
 * Merge one streamed chunk into the text a block already holds, using the
 * chunk's `offset` (how much of the block preceded it — see `assistant.delta`
 * in contract/common.ts).
 *
 * A plain `have + chunk` is only right when the two are exactly adjacent. The
 * cases that broke it:
 *  - `offset < have.length` — the block was seeded by hydration and this chunk
 *    is (partly) inside that seed. Appending it verbatim duplicated text; only
 *    the part past the seed is new, and a fully-covered chunk changes nothing.
 *  - `offset > have.length` — a chunk went missing. Nothing can reconstruct it
 *    here, so keep the new text (losing more helps no one); `assistant.done`
 *    carries the complete text and repairs the gap when the block closes.
 */
export function mergeDelta(have: string, chunk: string, offset: number): string {
  if (offset >= have.length) return have + chunk;
  const fresh = chunk.slice(have.length - offset);
  return fresh === '' ? have : have + fresh;
}

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
        const text = mergeDelta(b.text, a.text, a.offset);
        return text === b.text ? state : replace(i, { ...b, text });
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
      const { glyphColor, bodyColor } = assistantColors(false);
      // The event carries the block's complete text, so a `done` for a block we
      // never saw open (every delta lost, or a block that finished before this
      // view subscribed) still renders in full rather than being dropped.
      if (i === -1) {
        return {
          blocks: [
            ...state.blocks,
            { kind: 'assistant', blockId: a.blockId, isStreaming: false, glyph: '●', glyphColor, bodyColor, text: a.text },
          ],
        };
      }
      const b = state.blocks[i];
      if (b.kind !== 'assistant') return state;
      // Authoritative repair: whatever the stream lost, the final text wins.
      return replace(i, { ...b, isStreaming: false, glyphColor, bodyColor, text: a.text });
    }
    case 'toolStart': {
      if (idx(a.blockId) !== -1) return state;
      return { blocks: [...state.blocks, classifyToolStart(a.tool, a.summary, a.blockId, a.model)] };
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

// ---------- session-event application (conversation-view FR-8/9/10) ----------

export type TranscriptDispatch = (action: TranscriptAction) => void;

/** The non-reducer component state a SessionEvent can also touch. */
export interface ConversationEventSetters {
  setStatus: (status: SessionStatus) => void;
  setErrorMessage: (message: string | undefined) => void;
  setResumeFailed: (value: boolean) => void;
  /** The raw `USAGE_LIMIT` message, or null to clear the notice. */
  setLimitNotice: (message: string | null) => void;
  setPinned: (value: boolean) => void;
  setCommands: (commands: SlashCommandInfo[]) => void;
  patchUsage: (usedTokens: number, limitTokens: number) => void;
}

type SessionEventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

type SessionEventHandler<T extends SessionEvent['type']> = (
  dispatch: TranscriptDispatch,
  setters: ConversationEventSetters,
  e: SessionEventOf<T>,
) => void;

/** session.removed / agent.update / agent.step / mcp.update / workflow.update:
 * owned by other panels' own subscriptions (sidebar / agents-panel / mcp-panel /
 * workflows-panel) — no-op here, matching the original switch's
 * `default: break`. */
function ignoreEvent(): void {}

/**
 * Per-`SessionEvent['type']` handler table, replacing the 21-branch `route(e)`
 * switch that used to live inline in ConversationView's hydration effect. A
 * `Record<SessionEvent['type'], handler>` (§7) rather than an exhaustive
 * switch with a `never` default: the original switch was NOT exhaustive on
 * purpose (4 member types are intentionally ignored here — see `ignoreEvent`
 * above), and a plain switch's `default: break` would still silently swallow
 * a genuinely missing case the same way. The Record instead forces an
 * explicit (possibly no-op) entry per member, so a newly added SessionEvent
 * variant fails to compile here until someone decides what this view does
 * with it.
 */
const SESSION_EVENT_HANDLERS: { [T in SessionEvent['type']]: SessionEventHandler<T> } = {
  'session.status': (_dispatch, setters, e) => setters.setStatus(e.status),
  'session.meta': (_dispatch, setters, e) => {
    setters.setStatus(e.meta.status);
    setters.setErrorMessage(e.meta.errorMessage);
  },
  'session.error': (_dispatch, setters, e) => {
    // USAGE_LIMIT is NOT terminal (contract/common.ts): the core keeps the
    // session alive and a `session.status` idle follows. Flipping the view to
    // `error` here would disable the composer, and nothing is emitted when the
    // plan window resets to enable it again — the bug this branch exists for.
    // It surfaces as a dismissible banner instead, cleared by the next turn.
    if (e.error.code === 'USAGE_LIMIT') {
      setters.setLimitNotice(e.error.message);
      return;
    }
    setters.setErrorMessage(e.error.message);
    setters.setStatus('error');
  },
  'context.usage': (_dispatch, setters, e) => setters.patchUsage(e.usedTokens, e.limitTokens),
  'message.user': (dispatch, setters, e) => {
    dispatch({ t: 'msgUser', blockId: e.blockId, text: e.text });
    setters.setResumeFailed(false); // a new user turn clears the resume-fail notice (FR-14)
    setters.setLimitNotice(null); // …and the usage-limit notice: the user is retrying
  },
  // the --resume was rejected; core continued fresh (FR-9/14)
  'session.resumeFailed': (_dispatch, setters) => setters.setResumeFailed(true),
  'session.cleared': (dispatch, setters) => {
    // /clear full reset: drop every block (context.usage 0 resets the meter)
    dispatch({ t: 'clear' });
    setters.setResumeFailed(false);
    setters.setPinned(true);
  },
  'assistant.delta': (dispatch, _setters, e) => dispatch({ t: 'delta', blockId: e.blockId, text: e.text, offset: e.offset }),
  'assistant.done': (dispatch, _setters, e) => dispatch({ t: 'assistantDone', blockId: e.blockId, text: e.text }),
  'tool.start': (dispatch, _setters, e) =>
    dispatch({ t: 'toolStart', blockId: e.blockId, tool: e.tool, summary: e.summary, model: e.model }),
  'tool.done': (dispatch, _setters, e) => dispatch({ t: 'toolDone', blockId: e.blockId, meta: e.meta }),
  // interactive-commands FR-20: pending command block (loading card)
  'command.started': (dispatch, _setters, e) => dispatch({ t: 'commandStarted', blockId: e.blockId, command: e.command }),
  // interactive-commands FR-20: upsert card; insert-if-unseen (instant notices)
  'command.output': (dispatch, _setters, e) => dispatch({ t: 'commandOutput', blockId: e.blockId, card: e.card }),
  // session-questions FR-6/16: insert the pending question card
  'question.asked': (dispatch, _setters, e) => dispatch({ t: 'questionAsked', blockId: e.blockId, questions: e.questions }),
  // session-questions FR-11/13/16: flip to answered/cancelled in place
  'question.resolved': (dispatch, _setters, e) =>
    dispatch({ t: 'questionResolved', blockId: e.blockId, state: e.state, answers: e.answers }),
  // permission-guardrails FR-2/24: insert the pending approval card
  'permission.asked': (dispatch, _setters, e) => dispatch({ t: 'permissionAsked', blockId: e.blockId, ask: e.ask }),
  // permission-guardrails FR-8/10/24: flip to allowed/denied/cancelled in place
  'permission.resolved': (dispatch, _setters, e) =>
    dispatch({ t: 'permissionResolved', blockId: e.blockId, state: e.state, rule: e.rule }),
  // slash-menu FR-10: idempotent replace — an open popup refilters in place
  'session.commands': (_dispatch, setters, e) => setters.setCommands(e.commands),
  'session.removed': ignoreEvent,
  'agent.update': ignoreEvent,
  'agent.step': ignoreEvent,
  'mcp.update': ignoreEvent,
  'workflow.update': ignoreEvent,
};

/** Apply one SessionEvent to the transcript reducer / component setters. */
export function applySessionEvent(dispatch: TranscriptDispatch, setters: ConversationEventSetters, e: SessionEvent): void {
  const handler = SESSION_EVENT_HANDLERS[e.type] as SessionEventHandler<SessionEvent['type']>;
  handler(dispatch, setters, e);
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

// ---------- render-time grouping of consecutive tool calls (design-refresh FR-7) ----------

export type TranscriptRenderItem =
  | { kind: 'single'; block: ConversationBlock }
  | { kind: 'tool-group'; blockId: string; blocks: ToolConversationBlock[] };

/**
 * Groups a run of consecutive `tool`-kind blocks (any tool/target — this runs
 * AFTER compactBlocks, which already merged identical repeats) into one
 * `tool-group` item so the view can render them inside a single hairline-
 * divided card (design-refresh FR-7 / the agent-tab trace, which shares this
 * same vocabulary). `subagent` blocks — a different glyph/color/banner
 * treatment — never join a tool run. A lone tool block still becomes a
 * one-item group, so every tool call gets the same card treatment.
 */
export function groupToolRuns(blocks: ConversationBlock[]): TranscriptRenderItem[] {
  const out: TranscriptRenderItem[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      const last = out[out.length - 1];
      if (last && last.kind === 'tool-group') {
        last.blocks.push(b);
        continue;
      }
      out.push({ kind: 'tool-group', blockId: b.blockId, blocks: [b] });
      continue;
    }
    out.push({ kind: 'single', block: b });
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

// Transcript block apply rules for the SESSION tab (conversation-view FR-10 +
// interactive-commands FR-20/21). Pure logic — extracted from ConversationView
// so the keyed idempotent upserts are unit-testable without the DOM.
//
// Every rule is a keyed upsert on blockId: replaying an event is a no-op or an
// identical replace, and out-of-order arrivals insert rather than drop.

import type { BlockId, CommandCard, PermissionAsk, PermissionRule, Result, SessionEvent, SessionQuestion, SessionStatus, SlashCommandInfo } from '../../../contract/common';
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
  /** transcript-scale FR-11: the count of trailing blocks actually rendered —
   *  reset to RENDER_WINDOW by `seed`/`clear`, widened by `expandWindow`/`prepend`. */
  windowSize: number;
}

/** transcript-scale FR-11: the frontend render cap — at most this many of the
 *  most recent HELD blocks are ever in the DOM. Ordinary streamed appends do
 *  NOT grow `windowSize`; a live turn simply slides the trailing window, and
 *  whatever falls out of it becomes an "earlier" block like any other. */
export const RENDER_WINDOW = 200;

/**
 * A block `groupTurns` (transcript-turns.ts) folds into an open ASSISTANT-role
 * turn — assistant prose, a tool call, or a subagent dispatch. A `user` block
 * is excluded on purpose: it always opens its own one-block turn there, so it
 * is a turn BOUNDARY, never a block a run continues across.
 */
function isOpenTurnBlock(b: ConversationBlock): boolean {
  return b.kind === 'assistant' || b.kind === 'tool' || b.kind === 'subagent';
}

/**
 * FR-11: where the trailing window starts. A plain `blocks.length - windowSize`
 * can land mid-run inside a multi-tool assistant turn — `groupTurns` would
 * fold the dropped earlier half and the kept later half into ONE turn, so
 * cutting between them silently drops that turn's earlier tool calls while
 * keeping its later ones. Walk the cut point back to the nearest turn
 * boundary using the same block-role rule `groupTurns` uses: while both the
 * candidate block and the one before it are part of an open assistant-role
 * run, they would be folded together, so the cut is not yet at a boundary.
 */
export function windowStartIndex(blocks: ConversationBlock[], windowSize: number): number {
  const raw = Math.max(0, blocks.length - windowSize);
  let i = raw;
  while (i > 0 && isOpenTurnBlock(blocks[i]!) && isOpenTurnBlock(blocks[i - 1]!)) i--;
  return i;
}

/** FR-11: the trailing slice of `state.blocks` actually rendered, extended
 *  back to the nearest turn boundary (windowStartIndex) so a window cut never
 *  splits one assistant turn's tool calls across the "earlier" row. */
export function windowedBlocks(state: TranscriptState): ConversationBlock[] {
  return state.blocks.slice(windowStartIndex(state.blocks, state.windowSize));
}

/**
 * FR-12 + design brief ("Data shown"): what the earlier-blocks row states.
 * `count: null` is the indefinite case — `hasMore` true means older blocks
 * exist on disk beyond what the core handed the frontend, so the true total
 * is unknown until a page is fetched; the row states no figure rather than a
 * guessed one. `visible: false` is the "exhausted" state (FR-12) — the row is
 * removed, not disabled, once every held block is rendered and hasMore is false.
 */
export interface EarlierRowState {
  visible: boolean;
  count: number | null;
}

export function earlierRowState(state: TranscriptState, hasMore: boolean): EarlierRowState {
  if (hasMore) return { visible: true, count: null };
  const count = Math.max(0, state.blocks.length - state.windowSize);
  return { visible: count > 0, count };
}

/** Thousands-separated, locale-independent (deterministic across CI). */
function withThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Design brief: "▲ 2,140 earlier blocks" / singular "▲ 1 earlier block" /
 *  indefinite "▲ earlier blocks" (count === null, FR-12). */
export function earlierRowLabel(count: number | null): string {
  if (count === null) return '▲ earlier blocks';
  if (count === 1) return '▲ 1 earlier block';
  return `▲ ${withThousands(count)} earlier blocks`;
}

/**
 * FR-13: what activating the earlier row does next. `fetching` gates the "two
 * rapid activations" edge case (§7) — the second activation while a page is
 * already in flight is a no-op.
 */
export type EarlierActivation = { kind: 'expand' } | { kind: 'fetch'; before: BlockId } | { kind: 'none' };

export function decideEarlierActivation(state: TranscriptState, hasMore: boolean, fetching: boolean): EarlierActivation {
  if (fetching) return { kind: 'none' };
  // The reducer already holds blocks beyond the window — reveal another page
  // of them without a round trip.
  if (state.blocks.length > state.windowSize) return { kind: 'expand' };
  if (!hasMore) return { kind: 'none' };
  const oldest = state.blocks[0];
  if (!oldest) return { kind: 'none' };
  return { kind: 'fetch', before: oldest.blockId };
}

/** transcript-perf FR-5: one buffered chunk inside the rAF coalescer. */
export interface DeltaChunk {
  text: string;
  offset: number;
}

export type TranscriptAction =
  | { t: 'seed'; blocks: ConversationBlock[] }
  | { t: 'optimisticUser'; blockId: string; text: string }
  | { t: 'msgUser'; blockId: string; text: string }
  | { t: 'delta'; blockId: string; text: string; offset: number }
  // transcript-perf FR-5: one or more same-blockId chunks accumulated over one
  // animation frame, applied in ONE reducer pass — see the 'deltaBatch' case.
  | { t: 'deltaBatch'; blockId: string; chunks: DeltaChunk[] }
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
  | { t: 'remove'; blockId: string }
  // transcript-scale FR-13: widen the render window by one page — the
  // reducer already holds the newly-revealed blocks.
  | { t: 'expandWindow' }
  // transcript-scale FR-13: prepend a fetched page, oldest-first, deduped by
  // blockId; the newly-added ones join the render window too (§ design brief
  // flow 3: they appear immediately above the row, not merely held).
  | { t: 'prepend'; blocks: ConversationBlock[] };

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
    return { blocks: next, windowSize: state.windowSize };
  };
  switch (a.t) {
    case 'seed':
      // transcript-scale FR-15: hydration/session-switch/`session.cleared` all
      // reset the window to RENDER_WINDOW.
      return { blocks: a.blocks, windowSize: RENDER_WINDOW };
    case 'optimisticUser': {
      if (idx(a.blockId) !== -1) return state;
      const b: UserConversationBlock = { kind: 'user', blockId: a.blockId, isStreaming: false, text: a.text };
      return { blocks: [...state.blocks, b], windowSize: state.windowSize };
    }
    case 'msgUser': {
      const i = idx(a.blockId);
      if (i !== -1) {
        const b = state.blocks[i];
        if (b.kind !== 'user') return state;
        return replace(i, { ...b, text: a.text });
      }
      const b: UserConversationBlock = { kind: 'user', blockId: a.blockId, isStreaming: false, text: a.text };
      return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        windowSize: state.windowSize,
      };
    }
    // transcript-perf FR-5: the rAF coalescer's own dispatch — one or more
    // same-blockId chunks accumulated over one animation frame, folded through
    // `mergeDelta` in arrival order inside this ONE reducer pass (one array
    // copy) instead of one dispatch per chunk. Text is byte-identical to
    // applying each chunk as its own 'delta' action (FR-9's acceptance).
    case 'deltaBatch': {
      const i = idx(a.blockId);
      if (i !== -1) {
        const b = state.blocks[i];
        if (b.kind !== 'assistant') return state;
        let text = b.text;
        for (const c of a.chunks) text = mergeDelta(text, c.text, c.offset);
        return text === b.text ? state : replace(i, { ...b, text });
      }
      let text = '';
      for (const c of a.chunks) text = mergeDelta(text, c.text, c.offset);
      const { glyphColor, bodyColor } = assistantColors(true);
      return {
        blocks: [
          ...state.blocks,
          { kind: 'assistant', blockId: a.blockId, isStreaming: true, glyph: '●', glyphColor, bodyColor, text },
        ],
        windowSize: state.windowSize,
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
          windowSize: state.windowSize,
        };
      }
      const b = state.blocks[i];
      if (b.kind !== 'assistant') return state;
      // Authoritative repair: whatever the stream lost, the final text wins.
      return replace(i, { ...b, isStreaming: false, glyphColor, bodyColor, text: a.text });
    }
    case 'toolStart': {
      if (idx(a.blockId) !== -1) return state;
      return { blocks: [...state.blocks, classifyToolStart(a.tool, a.summary, a.blockId, a.model)], windowSize: state.windowSize };
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
      return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
        return { blocks: [...state.blocks, b], windowSize: state.windowSize };
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
      // transcript-scale FR-15: /clear resets the window like a fresh seed.
      return { blocks: [], windowSize: RENDER_WINDOW };
    case 'remove': {
      const i = idx(a.blockId);
      if (i === -1) return state;
      const next = state.blocks.slice();
      next.splice(i, 1);
      return { blocks: next, windowSize: state.windowSize };
    }
    case 'expandWindow':
      return { blocks: state.blocks, windowSize: state.windowSize + RENDER_WINDOW };
    case 'prepend': {
      const existing = new Set(state.blocks.map((b) => b.blockId));
      const fresh = a.blocks.filter((b) => !existing.has(b.blockId));
      if (fresh.length === 0) return state; // FR-13: never duplicate a block already held
      return { blocks: [...fresh, ...state.blocks], windowSize: state.windowSize + fresh.length };
    }
  }
}

// ---------- transcript-perf FR-5/FR-7: the rAF delta coalescer's buffer ----------
//
// A ref-held (never state — spec §6) `Map<blockId, DeltaChunk[]>` inside
// useConversationTranscript. Pure so the "one dispatch per blockId, arrival
// order preserved" contract is testable without a rAF/DOM environment.

/** Buffers one delta chunk for `blockId`, preserving arrival order. */
export function pushDelta(buffer: Map<string, DeltaChunk[]>, blockId: string, text: string, offset: number): void {
  const list = buffer.get(blockId);
  if (list) list.push({ text, offset });
  else buffer.set(blockId, [{ text, offset }]);
}

/**
 * Drains the buffer into one `deltaBatch` action per blockId (first-seen
 * order) and empties it. Called on the animation-frame flush, on any
 * non-delta event (FR-6), and on unmount/session switch (FR-7).
 */
export function drainDeltas(buffer: Map<string, DeltaChunk[]>): TranscriptAction[] {
  const actions: TranscriptAction[] = [];
  for (const [blockId, chunks] of buffer) actions.push({ t: 'deltaBatch', blockId, chunks });
  buffer.clear();
  return actions;
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
  /** transcript-scale FR-15: /clear has no older history either. */
  setHasMore: (value: boolean) => void;
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
    setters.setHasMore(false); // transcript-scale FR-15: nothing older left to page
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

/**
 * useConversationTranscript's `isRelevant` (transcript-scale FR-21 regression
 * fix). `agent.update` / `workflow.update` carry no `sessionId` at all
 * (contract/common.ts), so `subscribeSessionEvents`'s router
 * (src/lib/session-events.ts) broadcasts them to EVERY session-scoped
 * handler, not just the session they describe. Both are already no-ops in
 * `SESSION_EVENT_HANDLERS` above, but letting them reach
 * `onTranscriptEvent` at all still forces its `flushDeltas()` — cancelling
 * the rAF delta coalescer and dispatching early — for every OTHER session's
 * subagent/workflow update (reopening transcript-perf FR-5/FR-8's cost).
 * Filtering them out here, before they are ever buffered or applied, is
 * cheaper than gating the flush after the fact.
 */
export function isTranscriptRelevantEvent(e: SessionEvent): boolean {
  return e.type !== 'agent.update' && e.type !== 'workflow.update';
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

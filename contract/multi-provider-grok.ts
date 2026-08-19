// contract/multi-provider-grok.ts — xAI / Grok integration, a fourth agent
// runtime. Authored from specs/multi-provider-grok.md §5, then RECONCILED
// against the real CLI per FR-11 (see "FR-11 reconciliation" below). Holds ONLY
// the Grok wire format — the account verbs (`addGrok`, `grokLogin`) live in
// contract/multi-account.ts in place, beside AccountAddCodexPayload, per the
// standing decision that a re-keyed domain is never split across a second file.
//
// AgentRuntime gained 'grok' in common.ts (FR-1); AccountKind gained 'grok-cli'
// in multi-account.ts (FR-2); CAPABILITIES gained a 'grok' row in
// multi-provider-seam.ts (FR-26). RuntimeCapability itself is unchanged —
// 'permissions' already exists.
//
// Core-internal by construction: mirrored by the parser in
// src-tauri/src/session/adapter/grok/wire.rs and translated there into the
// SessionEvent members the transcript already renders (FR-13). No frontend
// imports these; they live in contract/ because this is the file a reader
// checks that mirror against.
//
// ── FR-11 reconciliation (2026-08-17) ──────────────────────────────────────
// The frozen §5 was PROVISIONAL, derived from xAI's published docs + the Agent
// Client Protocol standard, and it guessed the envelope WRONG. `grok` 1.0.5
// (`@xai-official/grok`) was installed and exercised during the build:
//
//   1. `--output-format streaming-json` is NOT JSON-RPC/ACP. There is no
//      `{"jsonrpc":"2.0","method":"session/update","params":{"update":{
//      "sessionUpdate":…}}}` envelope. Each stdout line is a FLAT `type`-tagged
//      NDJSON object. Verified two ways: a live unauthenticated invocation
//      emits `{"type":"error","message":"Not signed in. …"}` (pinned verbatim
//      in wire.rs' tests), and the CLI's own bundled
//      `$GROK_HOME/docs/user-guide/14-headless-mode.md` documents the full
//      vocabulary — "Consume it by switching on `type`."
//   2. Usage fields are snake_case (`input_tokens`, `cache_read_input_tokens`,
//      …), not the guessed camelCase. §5 flagged this as its least-certain
//      part; it was right to.
//   3. `-s/--session-id` MINTS ONLY and errors on an existing id, so FR-8's
//      "same argv every turn" does not hold — the core takes the Codex-shaped
//      fallback FR-8 itself anticipated: `-s <id>` on the first turn,
//      `--resume <id>` after, both naming Francois' own SessionId. Argv is not
//      contract surface; see `grok/args.rs` for the full argv reconciliation
//      (the prompt is a flag VALUE `-p <PROMPT>`, not stdin, and `--cwd` is
//      real but deliberately unused).
//
// The types below describe the REAL wire. The ACP shapes the frozen §5 carried
// are gone rather than kept alongside: a contract that names a format nothing
// emits is worse than no contract. specs/multi-provider-grok.md §5 still
// carries the provisional shapes and should be amended to match this file.
//
// Still not fully verified: no xAI credential was available, so no authenticated
// turn was captured. `fixtures/exec_turn.jsonl` is assembled verbatim from the
// bundled docs' own worked examples. Re-run FR-11's reconciliation against a
// real authenticated capture when credentials exist.

/**
 * One stdout line of `grok -p --output-format streaming-json`, discriminated on
 * `type`.
 *
 * FR-12 — a non-JSON line, a JSON value carrying no `type`, or a `type` this
 * version does not know is IGNORED, never fatal. The vocabulary is explicitly
 * non-exhaustive: the CLI's own docs note `max_turns_reached` and
 * `auto_compact_*` among others, which is exactly why the union ends in a
 * forward-compatibility member.
 */
export type GrokLine =
  /** FR-14: a chunk of assistant text — a DELTA. Append, never replace. */
  | { type: 'text'; data: string }
  /** FR-18: parsed and DROPPED. BlockKind has no thinking member (§2). */
  | { type: 'thought'; data?: string }
  /** FR-15: opens a tool card, addressed by `toolCallId`. */
  | {
      type: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: GrokToolKind;
      status?: GrokToolStatus;
      /** Grok's own tool name, e.g. `read_file`. The card DISPLAYS Claude Code's
       *  vocabulary (Read/Write/Edit/Grep/Glob/Bash) per FR-15's naming rule. */
      toolName?: string;
      rawInput?: unknown;
      content?: GrokToolContent[];
      locations?: unknown[];
    }
  /** FR-15: completes that card IN PLACE, matched on the same `toolCallId`. */
  | {
      type: 'tool_call_update';
      toolCallId: string;
      status?: GrokToolStatus;
      title?: string;
      content?: GrokToolContent[];
      rawOutput?: unknown;
      locations?: unknown[];
    }
  /**
   * A per-response usage boundary. Recognized but NOT applied to the context
   * meter: FR-16 reads the meter off `end`'s aggregate only — one authoritative
   * figure, not a running sum (the same rule codex's `turn.completed` follows).
   */
  | { type: 'usage'; messageId?: string; stopReason?: GrokStopReason; usage?: GrokUsage;
      signature?: string }
  /** FR-18: parsed and DROPPED, same reasoning as `thought`. */
  | { type: 'plan'; entries?: unknown[] }
  /** The tool / slash-command inventory. No transcript block corresponds to it. */
  | { type: 'available_commands'; availableCommands?: unknown[] }
  /** FR-17: the turn's terminal line. */
  | {
      type: 'end';
      stopReason?: GrokStopReason;
      usage?: GrokUsage;
      sessionId?: string;
      requestId?: string;
      num_turns?: number;
      modelUsage?: unknown;
    }
  /**
   * FR-17: a failed spawn / auth / turn. Ends the turn ERRORED with `message`
   * surfaced. This is the line a `grok` with no credential emits before exiting.
   */
  | { type: 'error'; message?: string }
  /** Forward compatibility (FR-12): a `type` this version does not know. */
  | { type: string };

/**
 * FR-17. `refusal` or an `error` line ends the turn errored; `cancelled` after a
 * user brake ends it interrupted, not failed; anything else ends it cleanly.
 * Open-ended on purpose — an unrecognised reason must not fail a turn.
 */
export type GrokStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | string;

/**
 * FR-16 — snake_case off the real wire (reconciled; the frozen §5 guessed
 * camelCase). Both cache buckets occupy the context window even though they are
 * billed differently, so both count toward the meter; `reasoning_tokens` is a
 * SUBSET of `output_tokens` and must NOT be added twice — the CodexUsage lesson.
 * The docs' own total: input + cache_read + cache_creation + output.
 *
 * No usage reported ⇒ the meter stays empty rather than estimated.
 */
export interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** A subset of `output_tokens`. Never added to the total. */
  reasoning_tokens?: number;
}

/** A tool call's output. `content` members carry the text a card's body shows. */
export interface GrokToolContent {
  type: 'content' | 'diff' | string;
  content?: GrokContent;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

/** A content block. Only `text` is rendered in v1. */
export interface GrokContent {
  type: 'text' | string;
  text?: string;
}

/** FR-15: selects the card the view draws. Unknown ⇒ generic tool card. */
export type GrokToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | string;

export type GrokToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string;

/**
 * FR-9: `permissionMode` → Grok's sandbox profile. Grok's own vocabulary,
 * confirmed against the CLI's `docs/user-guide/18-sandbox.md` — the one part of
 * the provisional contract FR-11 found already correct. The mapping lives in the
 * core (`grok/args.rs`) because argv construction is core-shaped, and is
 * mirrored here so the contract names every value that can reach the CLI.
 * `devbox` and `strict` are declared but never SELECTED — see FR-9.
 *
 * No 'ask' member on purpose: this transport is non-interactive and the core
 * pins `--always-approve` on every invocation (FR-6).
 */
export type GrokSandbox = 'off' | 'workspace' | 'devbox' | 'read-only' | 'strict';

// contract/multi-provider-codex.ts — the `codex exec --json` event stream.
// Authored from specs/multi-provider-codex.md §5.
//
// This feature adds NO new IPC channel. It widens three existing unions —
// AgentRuntime (+'codex', common.ts), AccountKind (+'codex-cli',
// multi-account.ts) and RuntimeCapability (+'permissions', multi-provider-
// seam.ts) — and this file holds the one genuinely new vocabulary: the wire
// shapes of Codex's own event stream.
//
// CORE-INTERNAL BY CONSTRUCTION. No frontend imports these: the Rust core parses
// the stream and translates it into the SessionEvent members the transcript
// already renders (FR-13/FR-14), so nothing Codex-shaped crosses the boundary.
// They live in `contract/` anyway because they are a wire format we mirror with
// serde in src-tauri/src/session/adapter/codex/wire.rs, and this is the file a
// reader checks that mirror against.
//
// VERIFIED against codex-cli 0.147.0 on 2026-08-17 by live capture plus the
// binary's own serde tables — not inferred from documentation. Any field marked
// optional here is optional because Codex may omit it, not as defensive padding.

/**
 * Every event kind `codex exec --json` emits, one JSON object per stdout line.
 *
 * FR-12: a line that is not valid JSON, or carries no `type`, is IGNORED rather
 * than fatal — Codex prints human-readable preamble on some paths, and adds
 * event kinds between releases. A turn must never die on output it doesn't know.
 */
export type CodexEvent =
  /** Always first. `thread_id` is the resume anchor for every later turn (FR-8). */
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error?: CodexError }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | { type: 'error'; message?: string };

export interface CodexError {
  message?: string;
}

/**
 * Token accounting off `turn.completed`. FR-15 fills the context meter with
 * `input_tokens + cached_input_tokens + output_tokens` — cached input still
 * occupies the window even though it is billed differently, and
 * `reasoning_output_tokens` is a SUBSET of `output_tokens` (adding it would
 * double-count).
 */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * One item in a turn. `id` addresses it across `item.started` → `item.completed`,
 * which is what lets a tool card go live and then complete in place (FR-14).
 *
 * Verified item kinds in 0.147.0: agent_message, reasoning, command_execution,
 * file_change, mcp_tool_call, collab_tool_call, web_search, todo_list. The union
 * below covers the ones FR-13/FR-14 translate; the rest fall through the
 * catch-all member and are ignored.
 *
 * NOTE — no text deltas. `agent_message` arrives WHOLE in one `item.completed`;
 * `codex exec --json` has no streaming equivalent of Claude Code's
 * `--include-partial-messages`. `item.updated` is declared because
 * `command_execution` uses it for live output, and because a future Codex that
 * does stream text would arrive through it without a contract change.
 */
export type CodexItem =
  | { id: string; type: 'agent_message'; text?: string }
  /** Reasoning summary. Parsed, then dropped — the core has no thinking block kind (§2). */
  | { id: string; type: 'reasoning'; text?: string }
  | {
      id: string;
      type: 'command_execution';
      command?: string;
      /** stdout+stderr interleaved, as Codex aggregates them. May carry ANSI escapes. */
      aggregated_output?: string;
      /** null while in_progress. */
      exit_code?: number | null;
      status?: CodexItemStatus;
    }
  | { id: string; type: 'file_change'; changes?: CodexFileChange[]; status?: CodexItemStatus }
  | {
      id: string;
      type: 'mcp_tool_call';
      server?: string;
      tool?: string;
      status?: CodexItemStatus;
    }
  | { id: string; type: 'web_search'; query?: string }
  | { id: string; type: 'todo_list'; items?: unknown[] }
  /** Forward compatibility: an item kind this version does not know (FR-13). */
  | { id: string; type: string };

export type CodexItemStatus = 'in_progress' | 'completed' | 'failed';

export interface CodexFileChange {
  path: string;
  kind?: 'add' | 'delete' | 'update';
}

/**
 * FR-9: `permissionMode` → Codex sandbox policy. Codex's own vocabulary; the
 * mapping itself is in the core (`codex/args.rs`) because argv construction is
 * core-shaped, and is mirrored here so the contract names every value that can
 * reach the CLI.
 *
 * There is no 'ask' member on purpose. Codex has an approval policy that could
 * prompt, but this transport is non-interactive — the core pins
 * `approval_policy="never"` on every invocation (FR-7) so the sandbox is the
 * whole of the enforcement and nothing can silently block waiting for an answer
 * no one can give.
 */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

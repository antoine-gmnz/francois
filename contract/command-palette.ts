// contract/command-palette.ts — command-palette (⌘K modal). Authored from
// specs/command-palette.md §5. Imports only from common.ts.
//
// This feature owns NO IPC channels (the `francois:palette:*` domain is reserved
// but unused). These are the registry/runtime TYPES; the runtime functions with
// the signatures documented below live in `src/palette.ts` (a frontend-only
// module — there is no core boundary to mirror). Consumers import the types from
// here and the functions from `src/palette`.

import type { SessionId } from './common';

// ---------- registry context ----------

/**
 * Snapshot passed to `enabled` and `run`. Recomputed by the palette runtime
 * immediately before every filter/render pass while the palette is open (FR-9).
 * Sourced from other features' already-existing state (FR-21/FR-23).
 */
export interface PaletteContext {
  /** Currently active/selected session, or null if none. */
  activeSessionId: SessionId | null;
  /** Count of the active session's agents with status 'running'. 0 if no active session. */
  runningAgentCount: number;
}

// ---------- secondary step (second filtered list) ----------

export interface SecondaryStepItem {
  id: string;
  label: string;
  hint?: string;
}

export interface SecondaryStep {
  /** Shown in the input row in place of "run a command" (FR-16). */
  placeholder: string;
  /** Rendered as filterable rows; label matched like a top-level name (FR-10). */
  items: SecondaryStepItem[];
  /** Invoked with the picked item's id (FR-13, FR-17). Must return synchronously. */
  onPick: (id: string) => void;
}

// ---------- command registry ----------

export interface PaletteCommand {
  /** kebab-case, unique across the registry, e.g. 'new-session'. */
  id: string;
  /** Single glyph rendered in the 16px glyph column (FR-20). */
  glyph: string;
  /** Display name; also the string filtered/ranked against (FR-10). */
  name: string;
  /** Right-aligned dynamic hint. No arguments — reads live state via closure (FR-21). Omit for no hint. */
  hint?: () => string;
  /** Defaults to always-enabled if omitted (FR-22). */
  enabled?: (ctx: PaletteContext) => boolean;
  /** Must return synchronously; a SecondaryStep enters secondary mode, void closes the palette (FR-16). */
  run: (ctx: PaletteContext) => void | SecondaryStep;
}

// ---------- toasts (FR-24, FR-25) ----------

export type ToastKind = 'error' | 'info' | 'success';

// ---------- runtime API (implemented in src/palette.ts) ----------
// The following are the exported runtime functions (documented here as the
// feature's public surface; see src/palette.ts for the implementations):
//
//   registerPaletteCommand(command: PaletteCommand): void   // throws if id already registered (FR-6/7)
//   unregisterPaletteCommand(id: string): void              // no-op if absent
//   openPalette(): void
//   closePalette(): void
//   togglePalette(): void
//   isPaletteOpen(): boolean
//   showToast(message: string, kind: ToastKind): void

export type { SessionId };

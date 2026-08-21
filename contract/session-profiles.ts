// contract/session-profiles.ts — session profiles (registry, spawn args, snapshotting).
// Authored from specs/session-profiles.md §5. Imports shared vocabulary from common.ts;
// never redefines it. ProfileId / SessionProfileRef live in common.ts (because SessionMeta
// references them) and are re-exported here, per the ProjectId / ProjectDefaults precedent.
//
// Physical Tauri binding: francois:profiles:<verb> → command profiles_<verb>
// (snake_case), called via invoke('profiles_<verb>', payload) → Promise<Result<T>>.
//
// NO EVENT CHANNEL is defined here (spec §5 preamble): every profile mutation is initiated
// by this app's own frontend and resolves with the new state, so a push channel would carry
// nothing the response does not (the projects §5 preamble reasoning, verbatim).

import type { ProfileId, SessionProfileRef } from './common';

export type { ProfileId, SessionProfileRef };

// ---------- bounds (enforced in the core, FR-6) ----------

export const MAX_PROFILE_NAME = 60;
export const MAX_SYSTEM_PROMPT = 16384; // chars — a generous role doctrine that still leaves the
                                        // Windows 32767-char command line ample headroom (FR-12
                                        // puts the prompt in argv), incl. the WSL nesting case.
export const MAX_EXTRA_ARGS_RAW = 4096;

/**
 * FR-9. Refused at save time with a named reason. The first eight own the stream contract the
 * whole event pipeline parses; --model / --permission-mode / --dangerously-skip-permissions are
 * refused because a profile does not carry those any more — the PROJECT's session defaults own
 * them, and a profile smuggling them back in as raw argv would silently outrank the project;
 * --append-system-prompt is a v1 non-goal that would fight replace mode; --permission-prompt-tool
 * owns the stdio control channel.
 */
export const DENIED_ARG_FLAGS: readonly string[] = [
  '--output-format',
  '--input-format',
  '-p',
  '--print',
  '--include-partial-messages',
  '--resume',
  '-c',
  '--continue',
  '--model',
  '--system-prompt',
  '--append-system-prompt',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--permission-prompt-tool',
];

// ---------- the entity ----------

/**
 * A profile carries only what is NOT already a property of the project it runs in: an identity, a
 * role prompt, and raw passthrough argv. Model / effort / permission mode were removed — a profile
 * is always paired with a project, and the project's own session defaults own those three.
 */
export interface SessionProfile {
  id: ProfileId;
  name: string; // trimmed, 1–MAX_PROFILE_NAME; NOT unique (FR-3)
  /** Inline text. Present and non-empty ⇒ REPLACE mode: it replaces Claude Code's own prompt. */
  systemPrompt?: string;
  /** Verbatim as typed, for round-tripping the editor (FR-8). */
  extraArgsRaw?: string;
  /** Core-parsed tokens (FR-7); the argv actually appended. */
  extraArgs?: string[];
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// ---------- francois:profiles:list ----------

// invoke('profiles_list'): Promise<Result<SessionProfile[]>>   // ordered per FR-4; errors: 'INTERNAL'

// ---------- francois:profiles:create ----------

export interface ProfileCreateInput {
  name: string;
  systemPrompt?: string;
  extraArgsRaw?: string;
}
// invoke('profiles_create', req: ProfileCreateInput): Promise<Result<SessionProfile>>
// errors: 'INVALID_INPUT' (bounds, unterminated quote) · 'PROFILE_ARG_DENIED' · 'INTERNAL'

// ---------- francois:profiles:update ----------

export interface ProfileUpdateInput extends ProfileCreateInput {
  id: ProfileId;
}
// invoke('profiles_update', req: ProfileUpdateInput): Promise<Result<SessionProfile>>
// errors: 'PROFILE_NOT_FOUND' · 'INVALID_INPUT' · 'PROFILE_ARG_DENIED' · 'INTERNAL'

// ---------- francois:profiles:remove ----------

export interface ProfileRemoveInput {
  id: ProfileId;
}
// invoke('profiles_remove', req: ProfileRemoveInput): Promise<Result<null>>
// errors: 'PROFILE_NOT_FOUND' · 'INTERNAL'

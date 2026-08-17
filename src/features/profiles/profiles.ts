// session-profiles — feature-local pure logic (spec §6). Kept free of React so
// vitest's node environment covers all of it; ProfilesModal, ProfileField and
// the sidebar/welcome chips are thin renderers over these.
//
// The registry itself (ordering, persistence, denylist enforcement) lives in
// the core (FR-1..FR-11) — this module owns only what the frontend decides:
// resolving a profile against the New Session form (FR-21), the picker's option
// list, the non-blocking extra-args advisory (FR-10), and the modal's small
// derived copy.
//
// A profile no longer pre-fills model / effort / permission mode: it carries
// none of those, because it is always paired with a project and the project's
// own session defaults own them. Selecting a profile therefore leaves every
// other New Session control exactly as the project left it.

import type { AppError, ProfileId } from '../../../contract/common';
import { MAX_PROFILE_NAME, type SessionProfile } from '../../../contract/session-profiles';
import { profilesList } from '../../lib/api';

// ---------- resolution (FR-15/FR-16) ----------

/** The profile a session_create request should snapshot — null if unresolved. */
export function resolveProfile(profiles: SessionProfile[], profileId: ProfileId | null | undefined): SessionProfile | null {
  if (!profileId) return null;
  return profiles.find((p) => p.id === profileId) ?? null;
}

/**
 * FR-21: a project's default profileId, resolved against the live registry at
 * dialog-open time. One that no longer resolves is dropped SILENTLY — the
 * dialog opens with no profile selected, never an error.
 */
export function resolveProjectDefaultProfileId(
  profiles: SessionProfile[],
  profileId: ProfileId | undefined,
): ProfileId | null {
  if (!profileId) return null;
  return profiles.some((p) => p.id === profileId) ? profileId : null;
}

/**
 * The project's own default profile resolution — or null when a palette pick
 * (FR-24 story 4, "New session with profile…") is pending, meaning `profileId`
 * is owned this mount by that pending selection and useProjectDefaults must not
 * touch it at all (not even to reset it to '').
 */
export interface ProjectDefaultProfileResolution {
  profileId: ProfileId | '';
}

export function projectDefaultProfileResolution(
  profiles: SessionProfile[],
  projectDefaultProfileId: ProfileId | undefined,
  pendingProfileId: ProfileId | null,
): ProjectDefaultProfileResolution | null {
  if (pendingProfileId) return null;
  return { profileId: resolveProjectDefaultProfileId(profiles, projectDefaultProfileId) ?? '' };
}

// ---------- picker (New Session + Profiles modal) ----------

export const NO_PROFILE_LABEL = '— none —';

export interface ProfileOption {
  value: ProfileId | '';
  label: string;
}

/** FR-4 order is the core's; this just prepends the "none" row. */
export function newSessionProfileOptions(profiles: SessionProfile[]): ProfileOption[] {
  return [{ value: '', label: NO_PROFILE_LABEL }, ...profiles.map((p) => ({ value: p.id, label: p.name }))];
}

/** The slice DefaultsSection's generic field-def machinery needs (projects.ts). */
export interface ProfileOptionSource {
  id: ProfileId;
  name: string;
}

// ---------- extra args advisory (FR-9/FR-10) ----------

/**
 * FR-10: every token Francois does NOT itself model gets a non-blocking
 * advisory beside it. Every flag `extraArgs` can carry after a successful save
 * is, by construction, off the denylist — none of Francois's own modelled
 * controls (model/effort/permission-mode/…) ever reach here as raw argv,
 * because those are exactly the flags FR-9 refuses. So the rule collapses to:
 * every flag-shaped token (leading `-`) gets the advisory; plain values do not.
 */
export function flagAdvisoryTokens(extraArgs: string[] | undefined): string[] {
  if (!extraArgs) return [];
  return extraArgs.filter((t) => t.startsWith('-'));
}

// ---------- boot / refresh (no event channel — spec §5 preamble) ----------

/**
 * FR-4: hydrate `profiles` once (App.tsx boot) and again after every mutation
 * the Profiles modal makes — there is no push channel, so every write is
 * followed by a plain re-read, exactly like `projects` and `multi-account`
 * before their own registries got one.
 */
export async function loadProfiles(apply: (profiles: SessionProfile[]) => void): Promise<void> {
  const res = await profilesList();
  if (res.ok) apply(res.data);
}

// ---------- errors (FR-9) ----------

export interface ProfileArgDenial {
  flag: string;
  reason: string;
}

/** FR-9: the save refusal names the flag AND the reason — never a silent drop. */
export function profileArgDeniedDetail(error: AppError): ProfileArgDenial | null {
  if (error.code !== 'PROFILE_ARG_DENIED') return null;
  const detail = error.detail as { flag?: unknown; reason?: unknown } | undefined;
  if (!detail || typeof detail.flag !== 'string' || typeof detail.reason !== 'string') return null;
  return { flag: detail.flag, reason: detail.reason };
}

/**
 * §7 edge case: an unterminated quote (or an over-cap raw string) in
 * `extraArgsRaw` is `INVALID_INPUT` and "the editor points at the field" —
 * same anchoring as `profileArgDeniedDetail` above. The core's `INVALID_INPUT`
 * carries no structured `detail` naming the field (unlike `PROFILE_ARG_DENIED`),
 * so this reads the core's own message text (`BAD_EXTRA_ARGS_MSG` /
 * `UNTERMINATED_QUOTE_MSG`, both src-tauri/src/profiles/mod.rs), which always
 * names "extra args" for that field and never for `name`/`systemPrompt`.
 */
export function isExtraArgsInvalidInput(error: AppError): boolean {
  return error.code === 'INVALID_INPUT' && error.message.includes('extra args');
}

// ---------- chip (FR-17/FR-22) ----------

/**
 * FR-22: the chip renders the SNAPSHOTTED name, never re-resolved against the
 * registry — a deleted profile's name still shows. The tooltip states the
 * replace-mode consequence without reading the (possibly long) prompt text.
 */
export function profileChipTitle(ref: { name: string; replacesSystemPrompt: boolean }): string {
  return ref.replacesSystemPrompt ? `${ref.name} — replaces the system prompt` : ref.name;
}

// ---------- modal copy ----------

export function canSaveProfileName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROFILE_NAME;
}

/** The header count, mirroring projects' `projectCountLabel`. */
export function profileCountLabel(n: number): string {
  return `${n} profile${n === 1 ? '' : 's'}`;
}

/** How long a list row's prompt preview may run before it is elided. */
export const PROMPT_PREVIEW_MAX = 80;

/**
 * The list row's second line: the profile's role, at a glance. Newlines and runs
 * of whitespace collapse to single spaces — a prompt is usually multi-line, and
 * the row is one line — then it is elided at `PROMPT_PREVIEW_MAX`. A profile
 * with no prompt falls back to its raw extra args, and one with neither gets an
 * em dash so the row keeps its two-line shape.
 *
 * Elision here is belt-and-braces: the row also clips with `.truncate`, but that
 * would hand the layout a 16k-char string (`MAX_SYSTEM_PROMPT`) to measure.
 */
export function profileRowSubtitle(profile: SessionProfile): string {
  const prompt = profile.systemPrompt?.replace(/\s+/g, ' ').trim();
  if (prompt !== undefined && prompt !== '') {
    return prompt.length > PROMPT_PREVIEW_MAX ? `${prompt.slice(0, PROMPT_PREVIEW_MAX).trimEnd()}…` : prompt;
  }
  const args = profile.extraArgsRaw?.trim();
  return args !== undefined && args !== '' ? args : '—';
}

export function removeProfileConfirmText(name: string): string {
  return `remove profile "${name}"? sessions are kept; they keep its name`;
}

// §2's accepted consequence, stated where the prompt is authored (FR-23).
export const REPLACE_MODE_NOTE =
  'a system prompt here REPLACES Claude Code’s own — CLAUDE.md framing and tool-use doctrine are gone, so slash commands, questions and permission cards may behave differently.';

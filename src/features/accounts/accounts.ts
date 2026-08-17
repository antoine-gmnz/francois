// multi-account (specs/multi-account.md) — everything the account UI does that
// is not markup: the boot hydration + francois://account/event subscriptions
// (§6/FR-7/FR-12..FR-15), the registry resolutions the rest of the app reads
// (FR-18/FR-20/FR-30), and the display/copy derivations the modal, the
// status-bar chip and the sidebar badge render (FR-31..FR-36).
//
// Kept free of React so vitest's node environment covers all of it; every
// component under src/features/accounts/ is a thin renderer over these.
//
// The account shown by the status bar / usage bar is DERIVED from the selected
// session's accountId (§6) — never stored separately, so it can never drift.

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AccountId, AgentRuntime, AppError, SessionId, SessionMeta } from '../../../contract/common';
import { runtimeCapabilities } from '../../../contract/multi-provider-seam';
import type {
  Account,
  AccountAddEndpointPayload,
  AccountTestEndpointPayload,
  AccountUpdateEndpointPayload,
  EndpointProbe,
} from '../../../contract/multi-account';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import { accountList, onAccountEvent } from '../../lib/api';
import { meterChipViews, sessionResetLabel, type MeterChipView } from '../usage/usage';

// ---------------------------------------------------------------- the feed

/**
 * §6: hydrate `accounts` once with account_list, then follow account.list
 * (FR-7 emits the FULL list on every mutation, so this is a plain replace).
 * Returns the teardown; safe to call before listen() settles, and a hydration
 * that lands after a live event is dropped rather than rewinding the registry.
 */
export function startAccountFeed(apply: (accounts: Account[]) => void): () => void {
  let live = true;
  let sawEvent = false;
  let unlisten: UnlistenFn | undefined;

  void accountList()
    .then((res) => {
      if (!live || sawEvent || !res.ok) return;
      apply(res.data);
    })
    .catch(() => {
      /* the registry degrades to "Default only" — never throws (§7) */
    });

  void onAccountEvent((e) => {
    if (!live || e.type !== 'account.list') return;
    sawEvent = true;
    apply(e.accounts);
  })
    .then((u) => {
      if (!live) u();
      else unlisten = u;
    })
    .catch(() => {
      /* ignore — no account updates, rest of the app unaffected */
    });

  return () => {
    live = false;
    unlisten?.();
    unlisten = undefined;
  };
}

export interface LoginFeedHandlers {
  /** FR-12: raw PTY bytes, written verbatim into the xterm instance. */
  onData?: (loginId: string, data: string) => void;
  /** FR-13: the identity landed; the core already killed the PTY. */
  onDone?: (loginId: string, account: Account) => void;
  /** FR-14/FR-15/FR-16: the dir is already deleted by the time this arrives. */
  onFailed?: (loginId: string, error: AppError) => void;
}

/**
 * The login sub-stream of the same channel. Separate from startAccountFeed
 * because it is mounted only while the login view is up — and it does NOT
 * filter on a loginId: the id arrives from account:add's response, which can
 * settle after the first bytes, so the caller compares against its own ref.
 */
export function startLoginFeed(handlers: LoginFeedHandlers): () => void {
  let live = true;
  let unlisten: UnlistenFn | undefined;

  void onAccountEvent((e) => {
    if (!live) return;
    if (e.type === 'account.login.data') handlers.onData?.(e.loginId, e.data);
    else if (e.type === 'account.login.done') handlers.onDone?.(e.loginId, e.account);
    else if (e.type === 'account.login.failed') handlers.onFailed?.(e.loginId, e.error);
  })
    .then((u) => {
      if (!live) u();
      else unlisten = u;
    })
    .catch(() => {
      /* the login view shows its own timeout instead */
    });

  return () => {
    live = false;
    unlisten?.();
    unlisten = undefined;
  };
}

// ------------------------------------------------------------- resolution

export function findAccount(accounts: Account[], id: AccountId | undefined): Account | null {
  if (!id) return null;
  return accounts.find((a) => a.id === id) ?? null;
}

/**
 * FR-4: exactly one account carries isDefault. The two fallbacks are defensive,
 * for the window before the registry hydrates and for a core that somehow
 * cleared every flag: the built-in row, then the first row, then null.
 */
export function defaultAccount(accounts: Account[]): Account | null {
  return (
    accounts.find((a) => a.isDefault) ??
    accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID) ??
    accounts[0] ??
    null
  );
}

/**
 * FR-18/FR-20: the new-session modal's ACCOUNT value. `preferred` is the
 * project's snapshot default; one naming a removed account falls back to the
 * isDefault account rather than sending an id the core would refuse.
 */
export function resolveNewSessionAccountId(accounts: Account[], preferred: AccountId | undefined): AccountId {
  if (findAccount(accounts, preferred)) return preferred as AccountId;
  return defaultAccount(accounts)?.id ?? DEFAULT_ACCOUNT_ID;
}

/**
 * FR-18/FR-19: the `accountId` sent in `NewSessionRequest`. Always the selected
 * id, verbatim — the built-in `'default'` row is itself a valid account, so
 * there is never a reason to omit it. A prior version omitted the field
 * whenever the selection equalled `DEFAULT_ACCOUNT_ID`, which conflated
 * "explicitly picked the built-in Default account" with "no selection made":
 * with a DIFFERENT account carrying `isDefault`, an omitted field resolves to
 * THAT account, silently overriding the user's explicit choice. Sending the
 * selection verbatim is what FR-19's "stored verbatim" promises.
 */
export function accountIdForSessionCreate(accountId: AccountId): AccountId {
  return accountId;
}

/**
 * multi-provider-openai FR-21: the model picker's neutral group heading —
 * the SELECTED account's own label, sourced here (not from `agentRuntime`/
 * `protocol`, which FR-20's grep gate forbids any component from branching
 * on). "Provider is metadata, not identity" (design brief §Rule 1): this is
 * deliberately the account's label, not a vendor name — a GPT session and a
 * Claude session read as the same kind of object, just under a different
 * account. Empty before the registry hydrates (or for an id it never knew),
 * so the picker simply renders no heading yet rather than a fabricated one.
 */
export function modelPickerProviderHeading(accounts: Account[], accountId: AccountId): string {
  const account = findAccount(accounts, accountId);
  return account ? accountDisplayLabel(account) : '';
}

/**
 * FR-30: which account's snapshot the usage bar renders and the status-bar chip
 * names — the SELECTED session's, or the isDefault account with no session
 * selected. An accountId that no longer resolves reads as the default (FR-10).
 */
export function usageAccountId(
  accounts: Account[],
  sessions: SessionMeta[],
  activeSessionId: SessionId | null,
): AccountId {
  const session = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
  return resolveNewSessionAccountId(accounts, session?.accountId);
}

// ----------------------------------------------------------------- display

/** FR-3: an identity-less built-in row reads `Default`, never a blank line. */
export function accountDisplayLabel(account: Account): string {
  const label = account.label.trim();
  if (label !== '') return label;
  return account.email ?? 'Default';
}

/** Design brief: when the label IS the email, the row shows the email alone. */
export function accountSecondaryEmail(account: Account): string | null {
  if (!account.email) return null;
  return account.email === accountDisplayLabel(account) ? null : account.email;
}

/** FR-22/FR-23: the row (and the chip) read as needing `Re-login`. */
export function accountNeedsLogin(account: Account): boolean {
  return account.authFailedAt !== undefined;
}

function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * FR-32 / design brief: the first 2 letters of the label, or — when the label
 * is just the email — the email's local part capped at 6. Uppercase mono, so
 * the badge stays legible at 10px.
 */
export function accountBadgeText(account: Account): string {
  const label = accountDisplayLabel(account);
  if (account.email && account.email === label) return emailLocalPart(label).slice(0, 6).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

/** Redesign-4a visual reference: the colored initial tile on each account row. */
export function accountAvatarLetter(account: Account): string {
  return accountDisplayLabel(account).slice(0, 1).toUpperCase();
}

/**
 * A deterministic hue token per account, so a row's tile never shifts colour.
 * `--accent` is deliberately NOT in the ramp: design system v2 gives the acid
 * to the ONE live thing per view, and three accounts sitting in a list are not
 * that. An account that needs re-login takes the red family instead of its own
 * hue — redesign 4a paints the troubled account's tile in the error family, so
 * the row reads as wrong from the tile alone, not just from the pill.
 */
const AVATAR_HUES = ['--hue-blue', '--hue-teal', '--hue-purple', '--hue-slate'] as const;

export function accountAvatarHue(account: Account): string {
  if (accountNeedsLogin(account)) return 'var(--error)';
  let sum = 0;
  for (let i = 0; i < account.id.length; i++) sum = (sum + account.id.charCodeAt(i)) % 9973;
  return `var(${AVATAR_HUES[sum % AVATAR_HUES.length]})`;
}

/**
 * How many sessions each account is currently carrying, keyed by account id.
 * A session whose `accountId` no longer resolves counts toward the isDefault
 * account, matching where the core actually runs it (FR-9/FR-10) — so the
 * numbers on screen add up to the session list.
 */
export function accountSessionCounts(accounts: Account[], sessions: SessionMeta[]): Record<AccountId, number> {
  const counts: Record<AccountId, number> = {};
  for (const a of accounts) counts[a.id] = 0;
  for (const s of sessions) {
    const id = resolveNewSessionAccountId(accounts, s.accountId);
    if (counts[id] !== undefined) counts[id] += 1;
  }
  return counts;
}

/**
 * Redesign 4a: the dim second line under an account's name — `email · N
 * sessions`, either half optional. Null when there is nothing to say, so the
 * row collapses to one line rather than reserving a blank one.
 */
export function accountMetaLine(account: Account, sessionCount: number): string | null {
  const parts: string[] = [];
  const email = accountSecondaryEmail(account);
  if (email) parts.push(email);
  if (sessionCount > 0) parts.push(`${sessionCount} session${sessionCount === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface AccountBadge {
  text: string;
  /** The full label + email, for the row's native tooltip (design brief). */
  title: string;
}

/**
 * FR-32: sidebar rows on the isDefault account show NO badge, so the badge
 * always means "not the usual account". An id that resolves to nothing is the
 * default too (FR-10 prunes it at load).
 */
export function sessionAccountBadge(accounts: Account[], session: SessionMeta): AccountBadge | null {
  const account = findAccount(accounts, session.accountId);
  if (!account || account.isDefault) return null;
  const email = accountSecondaryEmail(account);
  const label = accountDisplayLabel(account);
  return { text: accountBadgeText(account), title: email ? `${label} · ${email}` : label };
}

/** Design brief: the status-bar chip truncates at ~18 chars with an ellipsis. */
export function statusChipLabel(label: string, max = 18): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

/**
 * §Responsive: "below ~900px window width it shows only the first 8
 * characters" — a hard character-count cutoff, not the usual ~18. AccountChip
 * feeds this straight into `statusChipLabel`'s `max`; the CSS ellipsis rule at
 * the same breakpoint stays as a pixel-width safety net underneath it.
 */
export function statusChipMaxChars(windowWidth: number): number {
  return windowWidth < 900 ? 8 : 18;
}

export interface AccountOption {
  value: AccountId;
  label: string;
  /** Dim secondary text in the option; absent when the label IS the email. */
  email: string | null;
  isDefault: boolean;
  needsLogin: boolean;
}

/** multi-provider-endpoint FR-1: an 'openai-compatible' account, not (yet) a claude-code-oauth one. */
export function accountIsEndpoint(account: Account): boolean {
  return account.kind === 'openai-compatible';
}

/** multi-provider-codex FR-24: a 'codex-cli' account. */
export function accountIsCodex(account: Account): boolean {
  return account.kind === 'codex-cli';
}

/**
 * Does a plan-limit probe make sense for this account?
 *
 * Derived from the capability table via the account's own runtime, so it is the
 * SAME source of truth the disabled usage bar reads — rather than a hand-kept
 * list of kinds to exclude. That distinction is not cosmetic: the previous
 * `!accountIsEndpoint(a)` negation silently admitted `codex-cli` the day that
 * kind was added, and the probe spawns `claude` pointed at the account's config
 * dir, which `claude` then initializes as its own.
 */
export function accountUsageProbeable(account: Account): boolean {
  return runtimeCapabilities(accountRuntime(account)).usageBar.available;
}

/**
 * The `AgentRuntime` an account's sessions run on — the frontend mirror of the
 * core's `AgentRuntime::from_account_kind` (multi-provider-seam FR-13a).
 *
 * The one place in `src/` allowed to map a kind to a runtime, for the same
 * reason `runtimeCapability.ts` is the one place allowed to read the table: FR-23
 * forbids components branching on the runtime, not helpers deriving it. Total
 * over `AccountKind`, so a fourth kind fails to typecheck here.
 */
function accountRuntime(account: Account): AgentRuntime {
  switch (account.kind) {
    case 'claude-code-oauth':
      return 'claude-code';
    case 'openai-compatible':
      return 'francois';
    case 'codex-cli':
      return 'codex';
  }
}

/**
 * multi-provider-codex FR-25: does this row's action say *Sign in* (never
 * authenticated) rather than *Re-login* (was, isn't now)?
 *
 * Only ever true for a Codex row: `signedIn` is the one field that can say
 * "no credential yet" BEFORE a turn has failed, and it is present iff the kind
 * is 'codex-cli' (FR-21a). Claude rows keep answering this through
 * `accountNeedsLogin`, which reads `authFailedAt`.
 */
export function codexNeedsFirstLogin(account: Account): boolean {
  return accountIsCodex(account) && account.signedIn === false;
}

/**
 * FR-25: the label on a Codex row's login action. `Sign in` before there is any
 * credential, `Re-login` once there was one — the same two words the Claude
 * rows use, chosen off `signedIn` rather than off a failure flag.
 */
export function codexLoginActionLabel(account: Account): string {
  return codexNeedsFirstLogin(account) ? 'Sign in' : 'Re-login';
}

/** FR-24: Save is disabled until the label has non-whitespace content. */
export function codexSaveDisabled(label: string, busy: boolean): boolean {
  return busy || label.trim() === '';
}

/** FR-24: the `account_add_codex` payload — label only, trimmed. */
export function codexAddPayload(label: string): { label: string } {
  return { label: label.trim() };
}

/**
 * FR-31: every account, in core order (FR-2 puts the built-in first).
 * multi-provider-openai FR-22: an endpoint row is fully selectable now — the
 * `disabled`/`disabledReason` block multi-provider-endpoint FR-14 shipped is
 * deleted, not just relaxed.
 */
export function accountFieldOptions(accounts: Account[]): AccountOption[] {
  return accounts.map((a) => ({
    value: a.id,
    label: accountDisplayLabel(a),
    email: accountSecondaryEmail(a),
    isDefault: a.isDefault,
    needsLogin: accountNeedsLogin(a),
  }));
}

// ------------------------------------------------------------ usage meters

export interface AccountMetersView {
  /** 'none' = `—` · 'loading' = the dim `…` idiom · 'error' · 'meters'. */
  kind: 'none' | 'loading' | 'error' | 'meters';
  chips: MeterChipView[];
  /**
   * Redesign 4a pairs every account bar with its reset (`resets in 4h 9m`).
   * Null when no clock was supplied, or when no meter yields a countdown.
   */
  reset: string | null;
  /** The failure text, kept alongside stale meters as the row's tooltip. */
  message: string | null;
}

/**
 * FR-34 row meters, mapping the per-account snapshot lifecycle onto what the
 * row renders. Stale meters survive a failed probe (usage-bar FR-18), so an
 * error WITH data still renders the chips and carries the message as a title.
 *
 * `now` is passed in rather than read from the clock here (same rule the usage
 * bar's derivations follow) — omit it and the row simply shows no countdown.
 */
export function accountMetersView(snapshot: UsageSnapshot | undefined, now?: number): AccountMetersView {
  const chips = meterChipViews(snapshot?.meters ?? []);
  const message = snapshot?.error?.message ?? null;
  const reset = now === undefined || !snapshot ? null : sessionResetLabel(snapshot.meters, now);
  if (chips.length > 0) return { kind: 'meters', chips, reset, message };
  if (!snapshot) return { kind: 'none', chips, reset: null, message: null };
  if (snapshot.status === 'loading') return { kind: 'loading', chips, reset: null, message: null };
  if (snapshot.status === 'error')
    return { kind: 'error', chips, reset: null, message: message ?? 'usage unavailable' };
  return { kind: 'none', chips, reset: null, message: null };
}

// ------------------------------------------------------------- modal copy

/** FR-36 — the one line of prose the modal carries, stated exactly once. */
export const ACCOUNTS_ISOLATION_NOTE =
  'Each added account keeps its own Claude Code configuration: settings, skills, agents and MCP servers are not shared.';

/**
 * §3's keyboard model, said out loud. The modal has always been fully
 * keyboard-driven and has never named a single key on screen, so every shortcut
 * had to be guessed; redesign 4a's footer idiom (quiet actions left, dim hint
 * right) is where they belong. Key first, verb after — the same order the
 * shell's own hint bars use.
 */
export const ACCOUNTS_KEY_HINTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '↑↓', label: 'move' },
  { key: '⏎', label: 'default' },
  { key: 'r', label: 'rename' },
  { key: 'del', label: 'remove' },
  { key: 'a', label: 'add' },
];

export const LOGIN_TITLE = 'LOGGING IN — complete the Claude Code sign-in below';
/** §Notes: Esc is intercepted by the modal, so the hint must be visible. */
export const LOGIN_CANCEL_HINT = 'Esc to cancel';

/** Design brief: at most five session names, then a `+N more`. */
const MAX_CONFIRM_SESSIONS = 5;

export interface RemoveConfirmView {
  title: string;
  credentialsLine: string;
  /** null when the account owns no session — nothing falls back (FR-9). */
  sessionsLine: string | null;
  names: string[];
  moreLabel: string | null;
}

/**
 * FR-35: the confirmation names the sessions that will fall back to `Default`
 * (FR-9) and states that the credentials on disk are deleted (FR-8).
 */
export function removeConfirmView(account: Account, sessions: SessionMeta[]): RemoveConfirmView {
  const bound = sessions.filter((s) => s.accountId === account.id);
  const rest = bound.length - MAX_CONFIRM_SESSIONS;
  return {
    title: `Remove ${accountDisplayLabel(account)}?`,
    credentialsLine: 'Its credentials on this machine will be deleted.',
    sessionsLine:
      bound.length === 0
        ? null
        : `${bound.length} session${bound.length === 1 ? '' : 's'} will fall back to Default:`,
    names: bound.slice(0, MAX_CONFIRM_SESSIONS).map((s) => s.name),
    moreLabel: rest > 0 ? `+${rest} more` : null,
  };
}

/**
 * §7 / design brief: the three login failures get their own plain sentence —
 * the core's own message is a diagnostic, not a thing to put in front of a user
 * mid-login. Anything else falls through to the core's message verbatim.
 */
export function loginErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'ACCOUNT_LOGIN_FAILED':
      return 'Login timed out';
    case 'ACCOUNT_DUPLICATE':
      return (
        'This Anthropic account is already registered — the credential store may be shared on ' +
        'this platform, so it cannot be isolated here.'
      );
    case 'PTY_ERROR':
    case 'SPAWN_FAILED':
      return 'Could not start claude';
    default:
      return error.message.trim() === '' ? 'Login failed' : error.message;
  }
}

// -------------------------------------------------------------- keyboard

/** §3: ↑/↓ move within the list and never wrap. */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, cursor + delta));
}

/** Re-clamps after a removal shortens the list. */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, cursor));
}

// ------------------------------------------------------ endpoint accounts
// multi-provider-endpoint FR-13..FR-16 — the Accounts modal's endpoint row
// extras (kind chip, base URL line — the not-yet note FR-14 shipped is
// deleted by multi-provider-openai FR-22) and the EndpointForm's pure logic
// (payload construction, probe/error copy, Save-disabled). The key itself
// never appears here: only `hasKey` crosses the boundary (FR-3), and the
// drafted key lives in the form component's own state, never a store.

/** Keeps both ends of a long value readable instead of clipping the tail. */
export function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1; // room for the ellipsis character
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Design brief §1: the row's dim `<baseUrl>` line, `no key` marker when keyless. */
export function endpointBaseUrlLine(account: Account): string | null {
  if (!account.endpoint) return null;
  const truncated = middleTruncate(account.endpoint.baseUrl, 40);
  return account.endpoint.hasKey ? truncated : `${truncated} · no key`;
}

/** FR-15: the key field's placeholder — never a hint of the real key. */
export function endpointKeyPlaceholder(hasKey: boolean): string {
  return hasKey ? '•••••••• stored' : 'sk-…';
}

/** Splits the Models field, trimming each id and dropping blanks (stray commas). */
export function parseModelIdsList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** FR-6: an empty Models field omits the field — the core discovers from /models. */
export function modelIdsForAdd(text: string): string[] | undefined {
  const ids = parseModelIdsList(text);
  return ids.length > 0 ? ids : undefined;
}

/** FR-7: an empty Models field on an EDIT form clears the override (null), not a no-op. */
export function modelIdsForUpdate(text: string): string[] | null {
  const ids = parseModelIdsList(text);
  return ids.length > 0 ? ids : null;
}

/** The inverse of modelIdsForAdd/Update — what the form's Models field shows on open. */
export function formatModelIds(modelIds: string[] | undefined): string {
  return modelIds ? modelIds.join(', ') : '';
}

/** Design brief §2 "Empty / adding": Save stays disabled until both are filled, or while busy. */
export function endpointSaveDisabled(label: string, baseUrl: string, busy: boolean): boolean {
  return busy || label.trim() === '' || baseUrl.trim() === '';
}

/**
 * Design brief §2 "Validation error" — the offending field takes the error
 * border. `INVALID_INPUT` is FR-4's Base-URL rule, and per FR-8 the contract
 * `account_test_endpoint` can return that same code (round-2 review MEDIUM) —
 * so the border must fire on either the Save error or the Test probe's error,
 * not Save alone.
 */
export function endpointBaseUrlHasError(saveError: AppError | null, probeError: AppError | null): boolean {
  return saveError?.code === 'INVALID_INPUT' || probeError?.code === 'INVALID_INPUT';
}

/** Design brief §2 "Test OK" — zero models is still success, never an error. */
export function endpointProbeSuccessLine(probe: EndpointProbe): string {
  return `reachable · ${probe.modelCount} model${probe.modelCount === 1 ? '' : 's'}`;
}

/**
 * A 3-digit HTTP status embedded in the core's UNREACHABLE message (FR-8's
 * "status in the message"). Anchored to the ONE core-guaranteed phrase that
 * actually carries a status — `format!("the endpoint returned HTTP {code}")`
 * in src-tauri/src/account/endpoint.rs::probe — rather than a bare
 * word-boundary scan: the other UNREACHABLE messages (connect refused, DNS,
 * timeout, transport errors) are free text that can embed an unrelated
 * 3-digit token (a port, a millisecond count, an attempt counter) which a
 * bare scan would misreport as a successful-looking status.
 */
const STATUS_IN_MESSAGE = /\breturned HTTP ([1-5]\d{2})\b/;

/** Design brief §2 "Test failed" / "Validation error" — one sentence, no stack, no URL echo. */
export function endpointErrorLine(error: AppError): string {
  switch (error.code) {
    case 'ACCOUNT_ENDPOINT_UNAUTHORIZED':
      return "the endpoint rejected that key";
    case 'ACCOUNT_ENDPOINT_UNREACHABLE': {
      const m = error.message.match(STATUS_IN_MESSAGE);
      return m ? `endpoint answered ${m[1]}` : "couldn't reach that URL";
    }
    default:
      // INVALID_INPUT (and everything else) — the core's message IS the rule.
      return error.message.trim() === '' ? 'could not save' : error.message;
  }
}

/**
 * FR-9: the probe is stateless and takes unsaved form values. An untouched
 * key field on an edit form sends `accountId` instead — the core probes with
 * that account's STORED key, never re-asking for it.
 */
export function endpointTestPayload(
  baseUrl: string,
  apiKeyDraft: string,
  accountId: AccountId | undefined,
): AccountTestEndpointPayload {
  const apiKey = apiKeyDraft.trim();
  if (apiKey !== '') return { baseUrl, apiKey };
  return accountId ? { baseUrl, accountId } : { baseUrl };
}

/** FR-6: builds account_add_endpoint's payload from the form's draft fields. */
export function endpointAddPayload(
  label: string,
  baseUrl: string,
  apiKeyDraft: string,
  modelsDraft: string,
): AccountAddEndpointPayload {
  const apiKey = apiKeyDraft.trim();
  return {
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey !== '' ? apiKey : undefined,
    modelIds: modelIdsForAdd(modelsDraft),
  };
}

/**
 * FR-7: builds account_update_endpoint's payload. `clearKey` and `apiKey` are
 * mutually exclusive BY CONSTRUCTION — the form clears one the moment the
 * other is touched (EndpointForm), so this never has to choose between them.
 */
export function endpointUpdatePayload(
  accountId: AccountId,
  label: string,
  baseUrl: string,
  apiKeyDraft: string,
  clearKey: boolean,
  modelsDraft: string,
): AccountUpdateEndpointPayload {
  const apiKey = apiKeyDraft.trim();
  return {
    accountId,
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: !clearKey && apiKey !== '' ? apiKey : undefined,
    clearKey: clearKey ? true : undefined,
    modelIds: modelIdsForUpdate(modelsDraft),
  };
}

/**
 * Design brief §1 "Default account" flash parity: which id in `after` was not
 * in `before` — what a just-saved endpoint row is, so the modal can flash it
 * the same way a fresh login does. Null when nothing was added (an edit, or a
 * removal).
 */
export function newlyAddedAccountId(before: Account[], after: Account[]): AccountId | null {
  const beforeIds = new Set(before.map((a) => a.id));
  return after.find((a) => !beforeIds.has(a.id))?.id ?? null;
}

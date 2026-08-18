// Redesign turn 8b ("Credential vault") — the provider axis the Accounts modal
// gained once an account stopped meaning "Anthropic".
//
// The design's premise: the flat list has two axes it never had — which
// PROVIDER, and whether the credential is a CLI LOGIN (a config dir, a plan, a
// quota that resets) or an API KEY (a secret, a base URL, no ceiling). This
// module is that premise as pure functions; every component under
// src/features/accounts/ is a thin renderer over them, matching the rest of the
// feature (see accounts.ts).
//
// Nothing here is persisted and nothing crosses the contract: a provider is
// DERIVED from fields `Account` already carries —
//
//   kind 'claude-code-oauth' → Anthropic       (the `claude` CLI login)
//   kind 'codex-cli'         → OpenAI          (the `codex` CLI login)
//   kind 'openai-compatible' → host(baseUrl) matched against the catalog,
//                              falling back to the `custom` row
//
// — so a registry written before this file existed groups correctly with no
// migration, and a provider we cannot yet authenticate is still an honest row
// rather than a hidden one.
//
// FR-23's rule still holds: no COMPONENT branches on a runtime or a kind. They
// branch on the capability flags below, which is the same trade
// `runtimeCapabilities()` makes on the session side.

import type { AccountId, SessionMeta } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import {
  accountIsCodex,
  accountIsEndpoint,
  accountNeedsLogin,
  codexLoginActionLabel,
  codexNeedsFirstLogin,
  resolveNewSessionAccountId,
} from './accounts';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'moonshot'
  | 'openrouter'
  | 'deepseek'
  | 'xai'
  | 'qwen'
  | 'custom';

/**
 * Which interactive CLI login a provider offers *here*. `null` is the honest
 * answer for the six providers whose own CLIs (gemini, kimi, qwen-code, …) this
 * app does not drive yet — the section renders "coming soon" instead of an
 * affordance that would do nothing.
 */
export type CliLogin = 'claude' | 'codex' | null;

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  /** The 2-letter tile the rail and the detail header draw (design: 24×24 / 36×36). */
  monogram: string;
  /**
   * A hue TOKEN, never a raw colour — accounts.css derives fill, edge and glyph
   * from this one value the way `.acc-avatar` already does for an account.
   * Deliberately drawn from the neutral `--hue-*` ramp: a provider tile carries
   * identity, not status, so it may never borrow --success / --error / --accent.
   */
  hue: string;
  cliLogin: CliLogin;
  /**
   * Prefilled into the endpoint form's Base URL. `null` ⇒ this provider has no
   * OpenAI-compatible surface we can drive, so the API KEYS section says so
   * rather than inviting a key that could never be used.
   */
  apiBaseUrl: string | null;
  /** Hostnames whose endpoint accounts belong to this provider (exact, lowercased). */
  hosts: readonly string[];
  /** Named in the "coming soon" note, so the sentence says which CLI is missing. */
  cliName: string | null;
}

/**
 * Catalog order IS rail order within each group (design: CONNECTED above
 * AVAILABLE, each in a stable order). `custom` sits last: it is the catch-all
 * for an endpoint pointed somewhere the catalog never heard of, so it must
 * never shadow a named provider.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    monogram: 'AN',
    hue: 'var(--hue-clay)',
    cliLogin: 'claude',
    // Anthropic's API is not an OpenAI /chat/completions surface, and the
    // adapter multi-provider-openai ships speaks exactly that. Offering a key
    // field here would be offering a credential this app cannot spend.
    apiBaseUrl: null,
    hosts: ['api.anthropic.com'],
    cliName: 'claude',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    monogram: 'OA',
    hue: 'var(--hue-teal)',
    cliLogin: 'codex',
    apiBaseUrl: 'https://api.openai.com/v1',
    hosts: ['api.openai.com'],
    cliName: 'codex',
  },
  {
    id: 'google',
    name: 'Google',
    monogram: 'GO',
    hue: 'var(--hue-blue)',
    cliLogin: null,
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hosts: ['generativelanguage.googleapis.com'],
    cliName: 'gemini',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    monogram: 'MO',
    hue: 'var(--hue-purple)',
    cliLogin: null,
    apiBaseUrl: 'https://api.moonshot.ai/v1',
    hosts: ['api.moonshot.ai', 'api.moonshot.cn'],
    cliName: 'kimi',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    monogram: 'OR',
    hue: 'var(--hue-slate)',
    cliLogin: null,
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    hosts: ['openrouter.ai'],
    cliName: null,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    monogram: 'DS',
    hue: 'var(--hue-blue)',
    cliLogin: null,
    apiBaseUrl: 'https://api.deepseek.com/v1',
    hosts: ['api.deepseek.com'],
    cliName: null,
  },
  {
    id: 'xai',
    name: 'xAI',
    monogram: 'XA',
    hue: 'var(--hue-slate)',
    cliLogin: null,
    apiBaseUrl: 'https://api.x.ai/v1',
    hosts: ['api.x.ai'],
    cliName: 'grok',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    monogram: 'QW',
    hue: 'var(--hue-purple)',
    cliLogin: null,
    apiBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    hosts: ['dashscope-intl.aliyuncs.com', 'dashscope.aliyuncs.com'],
    cliName: 'qwen-code',
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    monogram: '••',
    hue: 'var(--hue-slate)',
    cliLogin: null,
    // Empty rather than null: there IS a route (the generic endpoint form), the
    // URL is just the user's to supply.
    apiBaseUrl: '',
    hosts: [],
    cliName: null,
  },
] as const;

export function providerSpec(id: ProviderId): ProviderSpec {
  // Total by construction — every ProviderId above has an entry, and the
  // fallback exists only so callers never handle `undefined`.
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

/**
 * The host of a base URL, lowercased and without its port — tolerant of the
 * half-typed values the endpoint form accepts before the core normalizes them
 * (FR-4), so a saved account is never orphaned by a missing scheme.
 */
export function baseUrlHost(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    // No scheme (or worse). Fall back to reading up to the first `/` or `:`.
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return withoutScheme.split(/[/:?#]/)[0]?.toLowerCase() ?? '';
  }
}

/**
 * Which provider an account belongs to. Total over `AccountKind`, so a fourth
 * kind fails to typecheck here rather than landing silently in `custom`.
 */
export function providerIdForAccount(account: Account): ProviderId {
  switch (account.kind) {
    case 'claude-code-oauth':
      return 'anthropic';
    case 'codex-cli':
      return 'openai';
    case 'openai-compatible': {
      const host = baseUrlHost(account.endpoint?.baseUrl ?? '');
      if (host === '') return 'custom';
      return PROVIDERS.find((p) => p.hosts.includes(host))?.id ?? 'custom';
    }
  }
}

/** Design: a credential is either a CLI login (plan, quota, config dir) or a key. */
export function isKeyCredential(account: Account): boolean {
  return accountIsEndpoint(account);
}

/**
 * "Asking for something": a Claude row whose last turn failed auth, or a Codex
 * row that has never been signed in at all. Both read as the rail's red dot and
 * both pin the card's actions visible.
 */
export function accountWantsAttention(account: Account): boolean {
  return accountNeedsLogin(account) || codexNeedsFirstLogin(account);
}

/** The rail's 6×6 dot. `none` ⇒ the provider is not connected, so no dot at all. */
export type ProviderStatus = 'attention' | 'active' | 'idle' | 'none';

export interface ProviderGroup {
  spec: ProviderSpec;
  /** Every account on this provider, in registry order (FR-2 keeps built-in first). */
  accounts: Account[];
  /** The CLI-login half — what the CLI LOGINS section renders. */
  cliAccounts: Account[];
  /** The API-key half — what the API KEYS section renders. */
  keyAccounts: Account[];
  connected: boolean;
  status: ProviderStatus;
  /** The rail's dim second line: `2 logins · 1 key`, `needs login`, or the route. */
  meta: string;
  /** How many sessions this provider's credentials carry, summed. */
  sessionCount: number;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The AVAILABLE row's meta line — what connecting would actually mean here, so
 * the difference between "we drive its CLI" and "bring a key" is legible before
 * you click. Providers with neither route say so outright.
 */
function availableMeta(spec: ProviderSpec): string {
  const routes: string[] = [];
  if (spec.cliLogin) routes.push(`${spec.cliLogin} CLI`);
  if (spec.apiBaseUrl !== null) routes.push('api key');
  return routes.length > 0 ? routes.join(' · ') : 'coming soon';
}

function connectedMeta(cli: number, keys: number, attention: boolean): string {
  if (attention) return 'needs login';
  const parts: string[] = [];
  if (cli > 0) parts.push(pluralize(cli, 'login'));
  if (keys > 0) parts.push(pluralize(keys, 'key'));
  return parts.join(' · ');
}

/**
 * The rail, in one pass: every catalog provider, carrying the accounts that
 * resolved to it. Providers with no accounts stay in the list — they are the
 * design's AVAILABLE group, and "connecting a sixth is browsing, not a wizard".
 *
 * `sessionCounts` is the map `accountSessionCounts` already builds for the
 * modal, passed in rather than recomputed, so the rail's dots and the cards'
 * session lines can never disagree.
 */
export function providerGroups(
  accounts: Account[],
  sessionCounts: Record<string, number> = {},
): ProviderGroup[] {
  const byProvider = new Map<ProviderId, Account[]>();
  for (const account of accounts) {
    const id = providerIdForAccount(account);
    const bucket = byProvider.get(id);
    if (bucket) bucket.push(account);
    else byProvider.set(id, [account]);
  }

  return PROVIDERS.map((spec) => {
    const owned = byProvider.get(spec.id) ?? [];
    const keyAccounts = owned.filter(isKeyCredential);
    const cliAccounts = owned.filter((a) => !isKeyCredential(a));
    const attention = owned.some(accountWantsAttention);
    const sessionCount = owned.reduce((sum, a) => sum + (sessionCounts[a.id] ?? 0), 0);
    const connected = owned.length > 0;
    return {
      spec,
      accounts: owned,
      cliAccounts,
      keyAccounts,
      connected,
      status: !connected ? 'none' : attention ? 'attention' : sessionCount > 0 ? 'active' : 'idle',
      meta: connected ? connectedMeta(cliAccounts.length, keyAccounts.length, attention) : availableMeta(spec),
      sessionCount,
    };
  });
}

/** Design: two sections in the rail, CONNECTED over AVAILABLE. */
export function splitRail(groups: ProviderGroup[]): { connected: ProviderGroup[]; available: ProviderGroup[] } {
  return {
    connected: groups.filter((g) => g.connected),
    available: groups.filter((g) => !g.connected),
  };
}

/**
 * Which provider the modal opens on, and where the selection lands after a
 * removal empties the one you were looking at: the provider owning the DEFAULT
 * account, else the first connected one, else Anthropic. Never a provider that
 * vanished — `preferred` is honoured only if it is still in the catalog.
 */
export function resolveSelectedProvider(groups: ProviderGroup[], preferred: ProviderId | null): ProviderId {
  if (preferred && groups.some((g) => g.spec.id === preferred)) return preferred;
  const withDefault = groups.find((g) => g.accounts.some((a) => a.isDefault));
  if (withDefault) return withDefault.spec.id;
  return groups.find((g) => g.connected)?.spec.id ?? 'anthropic';
}

export function findGroup(groups: ProviderGroup[], id: ProviderId): ProviderGroup {
  return groups.find((g) => g.spec.id === id) ?? providerGroups([])[0];
}

// ------------------------------------------------------------- section copy

/**
 * The two capability answers the detail pane's sections branch on — the ONE
 * place a "we don't do that yet" sentence is written, so the six unsupported
 * CLIs cannot drift into six different phrasings.
 */
export interface SectionState {
  available: boolean;
  /** Rendered in place of the add affordance when `available` is false. */
  comingSoon: string | null;
}

export function cliSectionState(spec: ProviderSpec): SectionState {
  if (spec.cliLogin) return { available: true, comingSoon: null };
  return {
    available: false,
    comingSoon: spec.cliName
      ? `Signing in with the ${spec.cliName} CLI is coming soon.`
      : `${spec.name} has no CLI to sign in with — add an API key instead.`,
  };
}

export function keySectionState(spec: ProviderSpec): SectionState {
  if (spec.apiBaseUrl !== null) return { available: true, comingSoon: null };
  return {
    available: false,
    comingSoon: `${spec.name} keys are coming soon — its API is not OpenAI-compatible, so it needs an adapter of its own.`,
  };
}

/**
 * Design: the caption under both sections. Provider-specific, because the
 * sentence is only true of CLI logins — "Keys keep none" is the second half.
 */
export function providerIsolationNote(group: ProviderGroup): string {
  const cliHalf =
    group.spec.cliLogin !== null
      ? `Each ${group.spec.name} login keeps its own configuration — skills, agents and MCP servers do not cross between them. `
      : '';
  return `${cliHalf}API keys keep no configuration of their own.`;
}

/**
 * The card's footer meta (design: "plan · own config dir · 3 sessions: a, b, c").
 * Session names come from the caller, capped, so a credential carrying twenty
 * sessions does not turn its card into a paragraph.
 */
const MAX_CARD_SESSIONS = 3;

export function credentialSessionLine(names: string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_CARD_SESSIONS);
  const rest = names.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : '';
  return `${pluralize(names.length, 'session')}: ${shown.join(', ')}${suffix}`;
}

/**
 * WHICH sessions each credential carries, not just how many — the mock names
 * them on the card, and "3 sessions: api-refactor, panel-rail, docs-pass" is
 * the whole reason the right pane exists ("room for what a row cannot hold").
 *
 * Resolved through `resolveNewSessionAccountId`, exactly like
 * `accountSessionCounts`, so a session pointing at a removed account is
 * attributed to the account that will actually run it (FR-9/FR-10) and the
 * names on screen always add up to the session list.
 */
export function accountSessionNames(accounts: Account[], sessions: SessionMeta[]): Record<AccountId, string[]> {
  const names: Record<AccountId, string[]> = {};
  for (const a of accounts) names[a.id] = [];
  for (const s of sessions) {
    const id = resolveNewSessionAccountId(accounts, s.accountId);
    names[id]?.push(s.name);
  }
  return names;
}

/**
 * The word on a credential card's login action, or `null` when the card has no
 * login route at all.
 *
 * Three cases, and the null one is load-bearing: the built-in account has no
 * config dir of its own — `claude` owns `~/.claude` directly — so there is
 * nothing for it to re-log into, and an endpoint account's credential is a key
 * you Edit, never an interactive sign-in. Codex rows say *Sign in* until there
 * is a credential to renew (FR-25), which `codexLoginActionLabel` decides.
 */
export function credentialLoginLabel(account: Account): string | null {
  if (accountIsEndpoint(account) || account.builtIn) return null;
  return accountIsCodex(account) ? codexLoginActionLabel(account) : 'Re-login';
}

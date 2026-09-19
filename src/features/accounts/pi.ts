// pi-provider-auth — the Accounts modal's Pi section: pure logic for the
// `account_add_pi` form, the trust/setup/refresh lifecycle, and the copy the
// design brief calls for. A Pi account is neither a CLI login nor an API key
// (providers.ts's two axes), so it gets its own module rather than being
// forced into either — matching the split accounts.ts/providers.ts/cliTools.ts
// already make for the shapes that came before it.
//
// Everything here is pure; PiForm.tsx/PiAccountCard.tsx/PiSetupView.tsx are
// thin renderers over it, matching the rest of this feature.

import type { AppError, ClaudeRuntime, SessionId, SessionMeta } from '../../../contract/common';
import { isWslUncPath, wslUncToLinux } from '../../../contract/wsl-filesystem';
import type { Account, PiAccountConfig, PiAccountCreateInput, PiProviderAuthObservation } from '../../../contract/multi-account';
import { MAX_CONFIRM_SESSIONS, type RemoveConfirmView } from './accounts';

/** multi-provider-seam-style predicate, matching accountIsCodex/accountIsGrok in accounts.ts. */
export function accountIsPi(account: Account): boolean {
  return account.kind === 'pi';
}

const MAX_LABEL = 60;

/** FR-1: trimmed 1..60 chars. `null` ⇔ valid. */
export function piLabelError(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed === '') return 'Enter a name for this account.';
  if (trimmed.length > MAX_LABEL) return `Keep it under ${MAX_LABEL} characters.`;
  return null;
}

/** FR-1: a directory must be given; existence/absoluteness is the core's call (§5). */
export function piConfigDirError(configDir: string): string | null {
  return configDir.trim() === '' ? 'Choose the Pi configuration directory.' : null;
}

/** FR-1: distro is required iff the environment is WSL. */
export function piDistroError(runtime: ClaudeRuntime, distro: string): string | null {
  return runtime === 'wsl' && distro.trim() === '' ? 'Name the WSL distro this directory lives in.' : null;
}

export function piSaveDisabled(
  label: string,
  configDir: string,
  runtime: ClaudeRuntime,
  distro: string,
  busy: boolean,
): boolean {
  return (
    busy ||
    piLabelError(label) !== null ||
    piConfigDirError(configDir) !== null ||
    piDistroError(runtime, distro) !== null
  );
}

/**
 * `useDirectoryPicker`'s own trick for a session cwd, reused verbatim here: a
 * chosen directory that resolves as a WSL UNC path (`\\wsl$\<distro>\…`)
 * names its own environment, so the form never asks a Windows user to pick it
 * by hand. Anything else stays 'native' — including every non-Windows
 * machine, which `isWslUncPath` already answers false for unconditionally.
 */
export function piDeriveEnvironment(configDir: string): { runtime: ClaudeRuntime; distro: string } {
  if (!isWslUncPath(configDir)) return { runtime: 'native', distro: '' };
  const parsed = wslUncToLinux(configDir);
  return { runtime: 'wsl', distro: parsed?.distro ?? '' };
}

/** FR-1/FR-4/FR-5: the `account_add_pi` payload, trimmed. `distro` is omitted for 'native'. */
export function piAddPayload(fields: {
  label: string;
  configDir: string;
  runtime: ClaudeRuntime;
  distro: string;
  inheritEnvironmentCredentials: boolean;
  trustConfiguration: boolean;
}): PiAccountCreateInput {
  const input: PiAccountCreateInput = {
    kind: 'pi',
    label: fields.label.trim(),
    configDir: fields.configDir.trim(),
    runtime: fields.runtime,
    inheritEnvironmentCredentials: fields.inheritEnvironmentCredentials,
    trustConfiguration: fields.trustConfiguration,
  };
  if (fields.runtime === 'wsl') input.distro = fields.distro.trim();
  return input;
}

/** design brief "Untrusted configuration: explain consent" / FR-4. */
export const PI_TRUST_CONSENT =
  "This directory's Pi configuration can contain executable credential helpers that Francois would run on " +
  'your behalf. Trusting it lets Francois launch Pi against this directory for setup and for sessions.';

/** FR-5, shown beside the inherit-credentials checkbox. */
export const PI_INHERIT_NOTE =
  "When on, this account's environment may override or augment Pi's own file-based credentials, per Pi's own " +
  'resolution rules — it is not a guarantee that two directories fully isolate inherited keys.';

/** design brief "Data shown" — the environment line a card/form renders. */
export function piEnvironmentLabel(pi: Pick<PiAccountConfig, 'runtime' | 'distro'>): string {
  return pi.runtime === 'wsl' ? `wsl · ${pi.distro ?? '?'}` : 'native';
}

export function piTrustLabel(trusted: boolean): string {
  return trusted ? 'Trusted' : 'Untrusted';
}

export function piTrustActionLabel(trusted: boolean): string {
  return trusted ? 'Revoke trust' : 'Trust';
}

export function piInheritLabel(inherit: boolean): string {
  return inherit ? 'inherits environment credentials' : 'no inherited credentials';
}

/** FR-4: setup (and any session use) is refused untrusted — say so before the click. */
export function piSetupBlockedReason(pi: Pick<PiAccountConfig, 'trusted'>): string | null {
  return pi.trusted ? null : 'Trust this configuration first.';
}

/** FR-8: the distinct, explicit "log out" affordance — the same PTY takeover as
 *  setup, worded for what an already-signed-in user is looking for. */
export const PI_LOGOUT_HINT = 'Open Pi setup to log out';

// -------------------------------------------------------- provider auth state

const OBSERVATION_LABEL: Record<PiProviderAuthObservation['state'], string> = {
  unknown: 'not checked',
  configured: 'configured',
  verified: 'verified',
  failed: 'failed',
};

/** FR-7's four states, in one word each. */
export function piObservationLabel(observation: PiProviderAuthObservation): string {
  return OBSERVATION_LABEL[observation.state];
}

export type ObservationTone = 'dim' | 'ok' | 'error';

/** Reuses the endpoint form's ok/error/dim vocabulary (`.acc-endpoint-result--*`). */
export function piObservationTone(observation: PiProviderAuthObservation): ObservationTone {
  if (observation.state === 'failed') return 'error';
  if (observation.state === 'verified' || observation.state === 'configured') return 'ok';
  return 'dim';
}

/** design brief "Data shown": relative time, the same granularity idiom as
 *  cliTools.ts's `runtimeCheckedAtLabel`. */
export function piObservationCheckedAtLabel(observation: PiProviderAuthObservation, nowMs: number = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - observation.checkedAt);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 5) return 'checked just now';
  if (seconds < 60) return `checked ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `checked ${hours}h ago`;
}

/** The card's one-line summary when there is no room for the full per-provider list. */
export function piObservationsSummary(observations: PiProviderAuthObservation[]): string {
  if (observations.length === 0) return 'not checked yet';
  const counts = new Map<PiProviderAuthObservation['state'], number>();
  for (const o of observations) counts.set(o.state, (counts.get(o.state) ?? 0) + 1);
  const order: PiProviderAuthObservation['state'][] = ['verified', 'configured', 'failed', 'unknown'];
  return order
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${OBSERVATION_LABEL[s]}`)
    .join(' · ');
}

// ------------------------------------------------------------------ errors

/**
 * §7 / FR-3/FR-4: the setup/refresh/trust failures get their own plain
 * sentence — the same discipline `loginErrorMessage` (accounts.ts) already
 * applies to the Claude PTY login. Anything else falls through to the core's
 * own message verbatim.
 */
export function piErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'ACCOUNT_CONFIG_UNTRUSTED':
      return 'This configuration is not trusted yet.';
    case 'ACCOUNT_CONFIG_CHANGED':
      return "This directory's executable configuration changed — trust it again to continue.";
    case 'ACCOUNT_IN_USE':
      return 'A session or setup window is using this account.';
    case 'RUNTIME_UNAVAILABLE':
      return 'Pi is not installed on this machine.';
    case 'RUNTIME_INCOMPATIBLE':
      return 'This Pi build is not on the certified list.';
    case 'RUNTIME_TIMEOUT':
      return 'Pi did not answer in time.';
    case 'RUNTIME_PROTOCOL_ERROR':
      return 'Pi answered with something Francois could not parse.';
    case 'PROVIDER_AUTH_FAILED':
      return 'Pi reported a provider authentication failure.';
    case 'PTY_ERROR':
    case 'SPAWN_FAILED':
      return 'Could not start Pi.';
    default:
      return error.message.trim() === '' ? 'Something went wrong.' : error.message;
  }
}

// -------------------------------------------------------------- removal (FR-6/FR-8)

/**
 * FR-6/FR-8: `account_remove` on a Pi account with running sessions rejects
 * with `ACCOUNT_IN_USE` and carries `blockedSessions` on the error's detail —
 * unlike the legacy flow (`removeConfirmView` in accounts.ts), which always
 * succeeds and reassigns to Default instead. Names the blocked sessions
 * rather than the generic fallback text, since nothing here falls back.
 */
export function piBlockedSessionsMessage(error: AppError, sessionNamesById: Map<SessionId, string>): string | null {
  if (error.code !== 'ACCOUNT_IN_USE') return null;
  const detail = error.detail as { blockedSessions?: SessionId[] } | undefined;
  const ids = detail?.blockedSessions ?? [];
  if (ids.length === 0) return 'This account is in use — stop its session(s) first.';
  const names = ids.map((id) => sessionNamesById.get(id) ?? id);
  return `Stop first: ${names.join(', ')}.`;
}

/**
 * FR-6/FR-8: the Pi-accurate analogue of `removeConfirmView` (accounts.ts).
 * Two things the legacy copy would get wrong for a Pi account: nothing "falls
 * back to Default" (a bound session instead BLOCKS the removal outright, see
 * `piBlockedSessionsMessage`), and Francois never deletes Pi's own
 * credentials — it only stops tracking the directory (FR-8).
 */
export function piRemoveConfirmView(account: Account, sessions: SessionMeta[]): RemoveConfirmView {
  const bound = sessions.filter((s) => s.accountId === account.id);
  const rest = bound.length - MAX_CONFIRM_SESSIONS;
  return {
    title: `Remove ${account.label.trim() || 'this Pi account'}?`,
    credentialsLine: "Francois stops tracking this directory — its Pi credentials on disk are untouched.",
    sessionsLine: bound.length === 0 ? null : 'Blocked while these sessions are running:',
    names: bound.slice(0, MAX_CONFIRM_SESSIONS).map((s) => s.name),
    moreLabel: rest > 0 ? `+${rest} more` : null,
  };
}

// The vendor-CLI half of the Accounts modal: is `claude` / `codex` / `grok`
// installed on this machine, and the `npm i -g` that fixes it if not.
//
// Why this sits beside providers.ts rather than inside it: a provider is a
// catalog ROW (identity, hosts, routes) and never changes at runtime, while a
// CLI's installed-ness is a live machine fact that changes while the modal is
// open. Same split the feature already makes between `Account` (registry) and
// `UsageSnapshot` (probe).
//
// Everything here is pure — the components under src/features/accounts/ are thin
// renderers over these functions, matching accounts.ts and providers.ts.

import type { AppError } from '../../../contract/common';
import type { CliToolId, CliToolStatus } from '../../../contract/multi-account';
import type { ProviderSpec } from './providers';

/** What the install card is doing right now. `done` is not a state: a finished
 *  install republishes the tool list, and an installed CLI has no card. */
export type CliInstallPhase = 'idle' | 'installing' | 'failed';

export interface CliInstallState {
  phase: CliInstallPhase;
  /** npm's merged output so far, bounded by `appendInstallOutput`. */
  output: string;
  error: AppError | null;
}

export const IDLE_INSTALL: CliInstallState = { phase: 'idle', output: '', error: null };

/**
 * How much npm output one install keeps in memory. npm under `--no-fund
 * --no-audit` prints a few hundred bytes on success and a page or two on
 * failure; the cap only ever bites on a pathological run, and it bites from the
 * FRONT because the reason is always at the end.
 */
const MAX_OUTPUT_CHARS = 20_000;

/** How many lines the card actually shows — a scrolling wall is not a status. */
export const OUTPUT_TAIL_LINES = 8;

export function appendInstallOutput(previous: string, chunk: string): string {
  const next = previous + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

/**
 * The last few non-empty lines, which is what npm's progress actually reads as
 * — it rewrites one line repeatedly, so the raw tail is mostly blanks and
 * carriage returns.
 */
export function outputTail(output: string, lines = OUTPUT_TAIL_LINES): string {
  const kept = output
    // npm redraws its progress bar with \r; keep only what it settled on.
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop() ?? l)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  return kept.slice(-lines).join('\n');
}

export function findCliTool(tools: CliToolStatus[], id: CliToolId | null): CliToolStatus | null {
  if (!id) return null;
  return tools.find((t) => t.id === id) ?? null;
}

/** The command shown as copyable text, and the one the button runs. */
export function installCommand(tool: CliToolStatus): string {
  return `npm i -g ${tool.npmPackage}`;
}

/**
 * The card's headline. Names the BINARY, not the package: "grok is not
 * installed" is what a user can check in their own terminal, whereas
 * "@xai-official/grok is not installed" sends them to npm to verify something
 * they already know.
 */
export function cliToolHeadline(tool: CliToolStatus): string {
  if (!tool.installed) return `${tool.bin} is not installed`;
  return tool.version ? `${tool.bin} ${tool.version}` : `${tool.bin} is installed`;
}

/**
 * Why the user would want it — provider-specific, because the answer genuinely
 * differs. For a provider Francois can already sign into, the CLI is what runs
 * every turn. For xAI it is not yet, and saying so is the whole reason the card
 * has copy at all rather than just a button.
 */
export function cliToolRationale(spec: ProviderSpec, tool: CliToolStatus): string {
  if (spec.cliLogin) {
    return `Francois signs in to ${spec.name} and runs its sessions through the ${tool.bin} CLI, so it has to be on your PATH.`;
  }
  return `Francois cannot drive ${tool.bin} for sessions yet — installing it now is the first half of that route, and it works on its own in a terminal meanwhile.`;
}

/**
 * FR-parity with the endpoint form: an affordance that cannot succeed is
 * disabled with a reason, never hidden. Signing in runs the vendor's CLI, so a
 * missing CLI makes "+ Add login" a button whose only outcome is SPAWN_FAILED.
 *
 * `null` ⇒ nothing blocks it. A tool list that has not loaded yet also returns
 * `null`: refusing the login because a probe is in flight would be worse than
 * letting a rare failure surface its own error.
 */
export function loginBlockedReason(spec: ProviderSpec, tool: CliToolStatus | null): string | null {
  if (!spec.cliLogin || !tool || tool.installed) return null;
  return `Install the ${tool.bin} CLI first — signing in to ${spec.name} runs it.`;
}

/**
 * What the install button says. Distinct from the phase so the label lives in
 * one place rather than in a ternary inside JSX, and so "Retry" after a failure
 * is not mistaken for a second, different action.
 */
export function installButtonLabel(state: CliInstallState, tool: CliToolStatus): string {
  if (state.phase === 'installing') return 'Installing…';
  if (state.phase === 'failed') return 'Retry install';
  return `Install ${tool.bin}`;
}

/**
 * Fold one `cli.install.*` event into the card's state. A `done` carrying no
 * error returns to `idle` — the refreshed tool list that arrives with it is what
 * removes the card, so leaving a "succeeded" phase behind would only be a state
 * nothing renders.
 */
export function reduceInstall(
  state: CliInstallState,
  event: { kind: 'output'; data: string } | { kind: 'done'; error?: AppError | null },
): CliInstallState {
  if (event.kind === 'output') {
    return { ...state, output: appendInstallOutput(state.output, event.data) };
  }
  return event.error
    ? { phase: 'failed', output: state.output, error: event.error }
    : IDLE_INSTALL;
}

/**
 * The failure line. npm's own tail is far more useful than "npm exited with
 * code 1", so it is preferred when the core attached one — the message alone
 * would send the user to search for a code that means nothing on its own.
 */
export function installErrorText(error: AppError): string {
  const detail = error.detail as { tail?: unknown } | undefined;
  const tail = typeof detail?.tail === 'string' ? outputTail(detail.tail, 4) : '';
  return tail !== '' ? `${error.message}\n${tail}` : error.message;
}

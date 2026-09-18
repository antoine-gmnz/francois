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
import type { RuntimeInstallProbeInput, RuntimeInstallStatus } from '../../../contract/pi-runtime-distribution';
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

// ------------------------------------------------------------- Pi runtime
//
// pi-runtime-distribution: `francois:runtime:installation` is a plain probe,
// not an install — there is no npm run to stream, only a read of what is
// already on the machine, so this state is simpler than CliInstallState above:
// idle (never asked) → probing → loaded (a RuntimeInstallStatus, itself
// carrying missing/incompatible/ready/probe-failed) or failed (the IPC call
// itself errored — INVALID_INPUT/INTERNAL, contract §5, not a health state).

export type RuntimeProbePhase = 'idle' | 'probing' | 'loaded' | 'failed';

export interface RuntimeProbeState {
  phase: RuntimeProbePhase;
  /** The last status this probe loaded, kept across a refresh so the card
   *  does not blank out while Retry is in flight. */
  status: RuntimeInstallStatus | null;
  /** Set only when the invoke itself failed — never for a health state, which
   *  is carried on `status.error` and rendered from there instead. */
  error: AppError | null;
}

export const IDLE_RUNTIME_PROBE: RuntimeProbeState = { phase: 'idle', status: null, error: null };

export function reduceRuntimeProbe(
  state: RuntimeProbeState,
  event: { kind: 'start' } | { kind: 'loaded'; status: RuntimeInstallStatus } | { kind: 'failed'; error: AppError },
): RuntimeProbeState {
  if (event.kind === 'start') return { phase: 'probing', status: state.status, error: null };
  if (event.kind === 'loaded') return { phase: 'loaded', status: event.status, error: null };
  return { phase: 'failed', status: state.status, error: event.error };
}

/**
 * francois:runtime:installation's request. FR-1/FR-8 give the core the
 * native/WSL environment axis, but this frontend slice ships no environment
 * picker (the design brief shows none) — it always probes native, `distro`
 * unset. `refresh` bypasses the core's 60s cache, for the Retry button.
 */
export function runtimeInstallProbeInput(refresh = false): RuntimeInstallProbeInput {
  return { runtime: 'native', refresh };
}

/**
 * The card's headline. Same "name the binary" discipline as `cliToolHeadline`:
 * says "Pi", the thing a user would look for, not the npm package.
 */
export function runtimeInstallHeadline(status: RuntimeInstallStatus | null): string {
  if (!status) return 'Checking for Pi…';
  switch (status.state) {
    case 'missing':
      return 'Pi is not installed';
    case 'incompatible':
      return status.detectedVersion ? `Pi ${status.detectedVersion} is not compatible` : 'Pi version is not compatible';
    case 'probe-failed':
      return 'Pi could not be checked';
    case 'ready':
      return status.detectedVersion ? `Pi ${status.detectedVersion}` : 'Pi is installed';
  }
}

/**
 * The one-line explanation under the headline — FR-4/FR-7's distinctions in
 * words: an incompatible build names what IS certified, and a ready-but-
 * unverified one says why it did not earn the stronger word.
 */
export function runtimeInstallNote(status: RuntimeInstallStatus | null): string {
  if (!status) return 'Checking your machine for a Pi installation.';
  switch (status.state) {
    case 'missing':
      return 'Francois drives Pi sessions through its own CLI once it is on your PATH.';
    case 'incompatible':
      return status.supportedVersions.length > 0
        ? `Certified: ${status.supportedVersions.join(', ')}.`
        : 'This build is not on the certified list Francois has tested against.';
    case 'probe-failed':
      return 'Checking the Pi installation failed.';
    case 'ready':
      return status.provenance === 'unverified'
        ? 'Matches a certified version, but its build identity could not be verified.'
        : 'Certified and ready to run Pi sessions.';
  }
}

/** The resolved path and Node version, when the probe found them (FR-7's
 *  point made visually: installation health, shown independently of login). */
export function runtimeDetailLines(status: RuntimeInstallStatus): string[] {
  const lines: string[] = [];
  if (status.executablePath) lines.push(status.executablePath);
  if (status.nodeVersion) lines.push(`Node ${status.nodeVersion}`);
  return lines;
}

/** §7: shown in setup, never as a provider login error — this IS that surface. */
export function runtimeErrorText(status: RuntimeInstallStatus): string | null {
  return status.error?.message ?? null;
}

/**
 * Design brief "Data shown": `checkedAt`, as a relative line ("checked just
 * now" / "checked Xm ago"). Kept out of `runtimeDetailLines` — that function's
 * own doc restricts it to the resolved path and Node version (FR-7's
 * installation-health pairing) — because `checkedAt` is a property of the
 * PROBE that produced a status, not of the installation itself.
 */
export function runtimeCheckedAtLabel(status: RuntimeInstallStatus, nowMs: number = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - status.checkedAt);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 5) return 'checked just now';
  if (seconds < 60) return `checked ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `checked ${hours}h ago`;
}

/**
 * The error line for the whole probe, combining both sources it can fail from:
 * an IPC-level failure (`probe.error`, set only when the `runtimeInstallation`
 * invoke itself rejected — INVALID_INPUT/INTERNAL, never a health state) and a
 * health-state failure carried on the last loaded status (`status.error`, the
 * `probe-failed` state). The IPC failure wins when both exist — it is the
 * newer failure, and a stale status could not have anticipated it.
 */
export function piSetupErrorText(probe: RuntimeProbeState): string | null {
  return probe.error?.message ?? (probe.status ? runtimeErrorText(probe.status) : null);
}

/**
 * On a first-load IPC failure there is no cached status yet (`status` is
 * `null`), so `runtimeInstallHeadline(null)` would read "Checking for Pi…"
 * forever even though the probe already failed. Treated as its own case
 * rather than folded into `runtimeInstallHeadline`, whose `null` input
 * legitimately means "no probe has answered yet" everywhere else it is called.
 */
export function piSetupHeadline(probe: RuntimeProbeState): string {
  if (probe.phase === 'failed' && !probe.status) return 'Pi could not be checked';
  return runtimeInstallHeadline(probe.status);
}

/** The note half of the same first-load-IPC-failure case above. */
export function piSetupNote(probe: RuntimeProbeState): string {
  if (probe.phase === 'failed' && !probe.status) return 'Checking the Pi installation failed.';
  return runtimeInstallNote(probe.status);
}

/** Missing/incompatible show "how to install the certified version" (§3);
 *  ready has nothing to install, and a probe failure is a Retry, not a copy. */
export function runtimeShowsInstallCommand(status: RuntimeInstallStatus): boolean {
  return status.state === 'missing' || status.state === 'incompatible';
}

export function runtimeRetryLabel(phase: RuntimeProbePhase): string {
  return phase === 'probing' ? 'Checking…' : 'Retry';
}

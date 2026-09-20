// contract/pi-runtime-distribution.ts — Pi installation discovery and version compatibility.
// Authored from specs/pi-runtime-distribution.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Channel (PIPELINE §Conventions binding):
//   francois:runtime:installation → invoke('runtime_installation', payload) → Promise<Result<RuntimeInstallStatus>>
//
// Missing/incompatible/probe-failure are SUCCESSFUL health responses (ok: true) carrying
// `error` on the status payload — they describe the runtime's own state, not an IPC failure.
// `Result.error` (the IPC-level AppError) is reserved for INVALID_INPUT (bad runtime/distro)
// and INTERNAL (registry/I/O failure). No new event stream.
//
// `PiCompatibilityManifest` (spec §5) is Rust-only state under
// src-tauri/src/session/adapter/pi/fixtures/ — it never crosses IPC, so it is not defined here
// (core-internal types are not part of the contract; see pi-runtime-boundary.md §"Rust-only").

import type { AppError, ClaudeRuntime } from './common';

/**
 * francois:runtime:installation request. `ClaudeRuntime` is the execution-environment axis
 * (native vs WSL, pi-runtime-boundary FR-1) — unrelated to the `AgentRuntime` provider axis.
 */
export interface RuntimeInstallProbeInput {
  runtime: ClaudeRuntime;
  /** Required iff `runtime === 'wsl'`; reject (INVALID_INPUT) when set off Windows or absent under wsl. */
  distro?: string;
  /** Bypass the 60s cache for this environment/binary. Default false. */
  refresh?: boolean;
}

/**
 * Health of the external Pi installation for one environment (FR-1..FR-8). Transient —
 * cached in the core, keyed by environment and resolved binary metadata, for 60s.
 */
export interface RuntimeInstallStatus {
  /**
   * 'missing' — no binary resolved on the login-shell PATH.
   * 'incompatible' — resolved, but its version/artifact identity is not on the
   *   certified allowlist (FR-4).
   * 'ready' — resolved and certified (or a same-version modified artifact that passed
   *   the protocol probe, see `provenance`).
   * 'probe-failed' — resolution or the version probe itself errored (timeout, malformed
   *   output, wrong executable) rather than yielding a definitive compatibility verdict.
   */
  state: 'missing' | 'incompatible' | 'ready' | 'probe-failed';
  /** Absolute path to the resolved executable, when one was found. */
  executablePath?: string;
  detectedVersion?: string;
  nodeVersion?: string;
  /** The certified package versions for this environment (FR-4/FR-5), for display. */
  supportedVersions: string[];
  /**
   * 'certified' — matches a pinned artifact digest on the allowlist.
   * 'unverified' — same package/version but a differing artifact identity; passed the
   *   protocol probe but its provenance could not be certified (FR-4).
   * 'unknown' — no certification attempt was meaningful (e.g. `state !== 'ready'`).
   */
  provenance: 'certified' | 'unverified' | 'unknown';
  /** Epoch ms this status was produced (fresh probe or cache read). */
  checkedAt: number;
  /** Display/copy only — never executed by François (FR-3). */
  installCommand: string;
  /**
   * Set when `state` is 'missing' | 'incompatible' | 'probe-failed'. Uses
   * RUNTIME_UNAVAILABLE / RUNTIME_INCOMPATIBLE / RUNTIME_TIMEOUT / RUNTIME_PROTOCOL_ERROR
   * (§7) — never a provider/authentication error code.
   */
  error?: AppError;
}

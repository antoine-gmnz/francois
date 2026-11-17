// claude-project-health — the pure half of the two pinned diagnostics banners
// (folder trust as `claude -p` reads it, and Cohorte's guard interpreter) plus
// the per-session probe cache. Contract: contract/claude-project-health.ts.

import type { ClaudeProjectHealth } from '../../../contract/claude-project-health';
import { sessionProjectHealth, sessionTrustFolder } from '../../lib/api';

/** Claude Code ignores the project's allow rules — only worth saying when there are some. */
export function trustBannerVisible(health: ClaudeProjectHealth | null | undefined, dismissed: boolean): boolean {
  return !!health && !dismissed && !health.trust.trusted && health.trust.allowRuleCount > 0;
}

/** The guard refuses every covered tool call while its interpreter is missing. */
export function guardBannerVisible(health: ClaudeProjectHealth | null | undefined, dismissed: boolean): boolean {
  return !!health && !dismissed && !!health.guard.interpreterMissing;
}

export function allowRulesPhrase(n: number): string {
  return n === 1 ? '1 permissions.allow rule' : `${n} permissions.allow rules`;
}

// ---- dismissal ----
// Trust: persisted per session (like the worktree notice) — the user chose to
// keep the approval prompts. Guard: in-memory only, so it returns next launch
// while the interpreter is still missing.

export const TRUST_BANNER_STORAGE_KEY = 'francois.trustBannerDismissed';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(TRUST_BANNER_STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isTrustBannerDismissed(sessionId: string): boolean {
  return readDismissed().includes(sessionId);
}

export function dismissTrustBanner(sessionId: string): void {
  try {
    const arr = readDismissed();
    if (!arr.includes(sessionId)) localStorage.setItem(TRUST_BANNER_STORAGE_KEY, JSON.stringify([...arr, sessionId]));
  } catch {
    /* ignore — the banner simply reappears next launch */
  }
}

const guardDismissed = new Set<string>();
export const isGuardBannerDismissed = (sessionId: string): boolean => guardDismissed.has(sessionId);
export const dismissGuardBanner = (sessionId: string): void => {
  guardDismissed.add(sessionId);
};

// ---- per-session probe cache ----

const cache = new Map<string, ClaudeProjectHealth>();

export function cachedProjectHealth(sessionId: string): ClaudeProjectHealth | null {
  return cache.get(sessionId) ?? null;
}

/** Probe the core and cache the answer. A failed probe keeps whatever was cached. */
export async function probeProjectHealth(sessionId: string): Promise<ClaudeProjectHealth | null> {
  const res = await sessionProjectHealth(sessionId);
  // The demo backend answers unscripted commands with `ok(null)`.
  if (res?.ok && res.data) cache.set(sessionId, res.data);
  return cachedProjectHealth(sessionId);
}

/** The explicit "Trust this folder" click. Resolves to an error message, or null on success. */
export async function trustFolder(sessionId: string): Promise<string | null> {
  const res = await sessionTrustFolder(sessionId);
  if (!res.ok) return res.error.message;
  if (res.data) cache.set(sessionId, res.data);
  return null;
}

/** Test seam. */
export function resetProjectHealthCache(): void {
  cache.clear();
  guardDismissed.clear();
}

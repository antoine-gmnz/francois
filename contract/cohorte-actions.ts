// cohorte-actions — drive the Cohorte pipeline from Francois (specs/cohorte-actions.md §5).
//
// Channels (logical → Tauri):
//   francois:cohorte:actionIntake  → `cohorte_action_intake`  (req: CohorteIntakeRequest)  → Result<CohorteIntakeResult>
//   francois:cohorte:actionPreview → `cohorte_action_preview` (req: CohorteIntakeRequest)  → Result<CohorteCommandPreview>
//   francois:cohorte:features      → `cohorte_v3_features` (existing; items gain `kind` + `updatedAt`, FR-5)
// Payloads are passed as `{ req }`, like the other cohorte_v3_* commands.
// Errors: INVALID_INPUT · COHORTE_CLI_MISSING · COHORTE_TIMEOUT · COHORTE_OUTPUT_CAPPED ·
//         COHORTE_OUTPUT_INVALID · COHORTE_REJECTED (detail { cohorteCode }) · COHORTE_COMMAND_FAILED.
// No events.

import type { Result } from './common';

export type CohorteIntakeSource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

export interface CohorteIntakeRequest {
  /** detected project root — the spawn's cwd */
  root: string;
  title: string;
  source: CohorteIntakeSource;
}

export type CohorteIntakeTriage = 'patch' | 'feature' | 'questions';

export interface CohorteIntakeResult {
  featureId: string;
  title: string;
  /** forward-compatible: an unknown triage string passes through */
  triage: CohorteIntakeTriage | (string & {});
  reasons: string[];
  questions: string[];
  /** FR-3 display string (no --json / --data-dir; long --text abbreviated) */
  command: string;
  durationMs: number;
}

export interface CohorteCommandPreview {
  command: string;
}

/** `cohorte_v3_features` item. `kind` and `updatedAt` are the FR-5 additions. */
export interface CohorteFeatureChoice {
  id: string;
  title: string;
  status: string;
  /** service `kind` (e.g. 'feature' | 'patch' | 'questions'); 'unknown' when absent */
  kind: string;
  /** epoch ms from `updated_at`; 0 when missing */
  updatedAt: number;
}

export type CohorteActionId =
  | 'intake'
  | 'brainstorm'
  | 'spec'
  | 'start'
  | 'patch'
  | 'fleet'
  | 'audit'
  | 'retro';

export const COHORTE_ACTION_LIMITS = {
  titleMax: 200,
  textMax: 24_000,
  urlMax: 2_000,
  timeoutMs: 30_000,
  /** FR-3: --text values longer than this render as `<text, N lines>` */
  textDisplayMax: 60,
} as const;

/** FR-43: the only feature ids that may be interpolated into a terminal line. */
export const COHORTE_SAFE_FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** FR-61: feature statuses that count as frozen. */
export const COHORTE_FROZEN_STATUSES: readonly string[] = ['frozen', 'ready', 'approved'];

export type CohorteIntakeResponse = Result<CohorteIntakeResult>;
export type CohortePreviewResponse = Result<CohorteCommandPreview>;

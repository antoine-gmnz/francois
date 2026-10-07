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
  /** Native preparation phase; determines the CLI continuation command. */
  phase?: string;
  artifacts?: string[];
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

export interface CohorteBrainstormRequest {
  root: string;
  featureId: string;
  idea?: string;
  source?: 'intake' | 'continue';
  message?: string;
  answer?: string;
}

export interface CohorteBrainstormTurn {
  brief: {
    feature_id: string;
    idea: string;
    prior_decisions: string[];
    user_messages: string[];
    user_answers: string[];
    contributions: { perspective: string; problem: string; alternatives: string[]; disagreements: string[]; risks: string[] }[];
    synthesis: {
      recommendation: string;
      strong_objections: string[];
      blocking_questions: string[];
      question_proposals: { question: string; business_option: string; code_option: string; caveat: string }[];
    };
  };
  brief_ref: { id: string; revision: number; sha256: string };
}

export interface CohorteSpecRequest {
  root: string;
  featureId: string;
  action: 'show' | 'propose' | 'accept' | 'prepare' | 'freeze' | 'ratify';
  message?: string;
  answers?: string[];
  contract?: string;
  expectProposalRevision?: number;
  expectDraftRevision?: number;
  requestId?: string;
  specHash?: string;
  profileHash?: string;
  candidateIndex?: number;
}

export interface CohorteSpecProposal {
  title: string;
  response_to_feedback: string;
  in_scope: string[];
  out_of_scope: string[];
  question_suggestions: { question: string; suggestion: string; caveat: string }[];
  scenarios: { id: string; given: string; when: string; then: string }[];
  acceptance: { statement: string; surface_id: string; check_id: string | null }[];
  test_strategy: string[];
  error_cases: string[];
  migrations_required: boolean;
  migrations: string;
  rollback: string;
}

export interface CohorteSpecDraft {
  feature_id: string;
  revision: number;
  status: 'draft' | 'frozen';
  title: string;
  problem: string;
  in_scope: string[];
  out_of_scope: string[];
  surfaces: string[];
  scenarios: { id: string; given: string; when: string; then: string }[];
  acceptance: { id: string; statement: string; verification: string; surface_ids: string[]; check_ids: string[] }[];
  test_strategy: string[];
  error_cases: string[];
  migrations: { required: boolean; plan: string };
  rollback: { required: boolean; plan: string };
  open_questions: string[];
}

export interface CohorteSpecData {
  feature_status?: string;
  brief_ref?: { id: string; revision: number; sha256: string };
  proposal?: CohorteSpecProposal | null;
  proposal_ref?: { id: string; revision: number; sha256: string } | null;
  draft_proposal_ref?: { id: string; revision: number; sha256: string } | null;
  draft?: CohorteSpecDraft | null;
  draft_ref?: { id: string; revision: number; sha256: string };
  draft_current?: boolean;
  feedback?: string[];
  profile?: { project_id: string; revision: number; surfaces: string[] };
  preparation?: { request_id: string; spec_hash: string; profile_hash: string };
  candidate?: CohorteSpecDraft;
  profile_snapshot?: Record<string, unknown>;
  spec?: CohorteSpecDraft;
  spec_ref?: { id: string; revision: number; sha256: string };
  standing_candidates?: { area: string; decision: string; reason: string; source_answer: string }[];
  entry?: string;
}

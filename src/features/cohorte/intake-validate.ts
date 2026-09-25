// cohorte-actions FR-10/FR-41 — the sheet's own pre-flight validation, so a bad
// field never waits on a round trip to learn it's bad. Mirrors the core's
// rules (src-tauri/src/cohorte/actions_cli.rs); the core is still the source
// of truth for what it actually accepts (INVALID_INPUT stays possible).

import { COHORTE_ACTION_LIMITS } from '../../../contract/cohorte-actions';

export interface IntakeFields {
  title: string;
  sourceKind: 'text' | 'file' | 'url';
  text: string;
  path: string;
  url: string;
}

/** First validation error, or null when the fields are ready to submit. */
export function intakeClientError(fields: IntakeFields): string | null {
  const title = fields.title.trim();
  if (title.length === 0) return 'Title is required';
  if (title.length > COHORTE_ACTION_LIMITS.titleMax) return `Title must be ${COHORTE_ACTION_LIMITS.titleMax} characters or fewer`;

  if (fields.sourceKind === 'text') {
    const text = fields.text.trim();
    if (text.length === 0) return 'Text is required';
    if (text.length > COHORTE_ACTION_LIMITS.textMax) {
      return 'Text is too long for the command line — save it to a file and use File';
    }
  } else if (fields.sourceKind === 'file') {
    if (fields.path.trim().length === 0) return 'Choose a file';
  } else {
    const url = fields.url.trim();
    if (url.length === 0) return 'URL is required';
    if (!/^https?:\/\//.test(url)) return 'URL must start with http:// or https://';
    if (url.length > COHORTE_ACTION_LIMITS.urlMax) return `URL must be ${COHORTE_ACTION_LIMITS.urlMax} characters or fewer`;
  }
  return null;
}

/** The /cohorte…-eligible draft: non-empty and not itself a /cohorte invocation. */
export function intakeSeedFromDraft(draft: string): string {
  const trimmed = draft.trim();
  return trimmed !== '' && !/^\/cohorte\b/.test(trimmed) ? draft : '';
}

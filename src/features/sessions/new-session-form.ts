// new-session-form — pure helpers shared by NewSessionModal's extracted
// hooks (useProjectDefaults derives the session name from a project's root;
// useDirectoryPicker derives it from a picked/typed path).

import type { ChipOption } from '../../ui/ChipGroup';

/** Last path segment, tolerant of both `/` and `\` separators. Falls back to
 * the input itself when it has no segments (e.g. an empty string). */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * `--effort` is optional; omitting it defers to Claude Code's OWN default,
 * which for coding work resolves to `xhigh`. The submitted VALUE for that
 * choice stays `''` (still omits the flag, per contract/session-engine.ts
 * SessionCreateInput.effort) — only the LABEL names the resolved value, so
 * the user isn't left guessing what "default" means.
 */
export const EFFORT_DEFAULT_LABEL = 'default (xhigh)';

/** EFFORT chip row options: the omit-the-flag default first, then the
 * model's advertised levels verbatim. */
export function buildEffortOptions(modelEfforts: string[]): ChipOption<string>[] {
  return [{ value: '', label: EFFORT_DEFAULT_LABEL }, ...modelEfforts.map((effort) => ({ value: effort, label: effort }))];
}

/**
 * NewSessionRequest.ultracode / SessionCreateInput.ultracode: "Omit for
 * false" (contract/sessions-sidebar.ts, contract/session-engine.ts) — a
 * literal `false` is never sent over the wire.
 */
export function ultracodeField(ultracode: boolean): true | undefined {
  return ultracode || undefined;
}

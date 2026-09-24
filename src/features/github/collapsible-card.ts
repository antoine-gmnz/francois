// github-ci-logs refinement — collapse state for pull-card / commit-card
// sections (Description, Checks, Files changed, Comments, Commit checks…),
// persisted per section id across detail switches and restarts. An absent id
// means "open" — the default — so a first run collapses nothing.

const STORAGE_KEY = 'francois.githubCollapsedSections';

export type CollapsedSections = Record<string, boolean>;

/** Pure, exported for tests: a malformed/non-object/non-boolean value never
 *  throws — unknown keys are dropped, only `true` entries survive. */
export function parseCollapsedSections(raw: string | null): CollapsedSections {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: CollapsedSections = {};
  for (const [id, collapsed] of Object.entries(parsed as Record<string, unknown>)) {
    if (collapsed === true) out[id] = true;
  }
  return out;
}

/** Toggles `id`'s collapsed flag; open ids are omitted from the record
 *  rather than stored as `false`, so the persisted shape only ever grows for
 *  sections someone actually collapsed. */
export function toggleCollapsedSection(sections: CollapsedSections, id: string): CollapsedSections {
  const next = { ...sections };
  if (next[id]) delete next[id];
  else next[id] = true;
  return next;
}

// Guarded the same way as layoutStore's collapsed panes: a restricted
// storage environment (or a node test env) degrades to defaults silently.
export function loadCollapsedSections(): CollapsedSections {
  try {
    return parseCollapsedSections(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveCollapsedSections(sections: CollapsedSections): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
  } catch {
    /* ignore */
  }
}

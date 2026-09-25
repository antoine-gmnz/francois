// Shared pure diffing for a Claude Code Edit/MultiEdit/Write tool input — the
// same fragment-diff algorithm feeds both the permission card's diff surface
// (features/permissions/permission-code.ts) and the step-detail panel's input
// band (features/conversation/step-syntax.ts), so the two never disagree about
// what a change looks like.
//
// Deliberately NOT a real unified diff: the tool input carries `old_string`/
// `new_string` fragments, not a file offset, so there is no line-number gutter
// to compute — see `diffRows`' own note on that.

export type DiffRowKind = 'context' | 'add' | 'del' | 'elision';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

/** 9b: "two lines of unchanged context" — one pair, so the change stays the subject. */
const CONTEXT_LINES = 2;
/** A change taller than this is elided: the card is a decision, not a code review. */
const MAX_CHANGE_ROWS = 12;

export interface Hunk {
  context: { before: string[]; after: string[] };
  removed: string[];
  added: string[];
}

/**
 * Trim the common head and tail off a replaced fragment, which is exactly the
 * derivation the core already uses for the `+N −M` meta (tools.rs edit_counts).
 * Doing it the same way here keeps the card's counts and the transcript row's
 * counts from ever disagreeing about the same edit.
 */
export function hunkOf(oldText: string, newText: string): Hunk {
  const olds = oldText === '' ? [] : oldText.split('\n');
  const news = newText === '' ? [] : newText.split('\n');
  let lead = 0;
  while (lead < olds.length && lead < news.length && olds[lead] === news[lead]) lead++;
  let trail = 0;
  while (
    trail < olds.length - lead &&
    trail < news.length - lead &&
    olds[olds.length - 1 - trail] === news[news.length - 1 - trail]
  ) {
    trail++;
  }
  return {
    context: {
      before: olds.slice(Math.max(0, lead - CONTEXT_LINES), lead),
      after: olds.slice(olds.length - trail, olds.length - trail + CONTEXT_LINES),
    },
    removed: olds.slice(lead, olds.length - trail),
    added: news.slice(lead, news.length - trail),
  };
}

/**
 * Lay the hunks out as rows.
 *
 * There is NO line-number gutter, and that is deliberate: an Edit's tool input
 * carries `old_string`, not a file offset, so any number in that column would
 * be a position within the fragment while reading as a line of the file beside
 * it in the header. The sign column, the row tint and the context lines carry
 * the same information without inviting that misreading.
 */
export function diffRows(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let dropped = 0;
  for (const h of hunks) {
    const changed = h.removed.length + h.added.length;
    const budget = Math.max(0, MAX_CHANGE_ROWS - rows.filter((r) => r.kind !== 'context').length);
    for (const text of h.context.before) rows.push({ kind: 'context', text });
    let shown = 0;
    for (const text of h.removed) {
      if (shown < budget) {
        rows.push({ kind: 'del', text });
        shown++;
      } else dropped++;
    }
    for (const text of h.added) {
      if (shown < budget) {
        rows.push({ kind: 'add', text });
        shown++;
      } else dropped++;
    }
    if (dropped === 0 || changed <= budget) {
      for (const text of h.context.after) rows.push({ kind: 'context', text });
    }
  }
  if (dropped > 0) rows.push({ kind: 'elision', text: `${dropped} more line${dropped === 1 ? '' : 's'}` });
  return rows;
}

export function parseInput(inputJson: string): Record<string, unknown> {
  if (inputJson === '') return {};
  try {
    const v: unknown = JSON.parse(inputJson);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** The hunks for one Edit/MultiEdit/Write tool input — `[]` when it carries no change. */
export function editHunks(toolName: string, input: Record<string, unknown>): Hunk[] {
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => hunkOf(str(e, 'old_string'), str(e, 'new_string')))
      .filter((h) => h.removed.length > 0 || h.added.length > 0);
  }
  // A Write is an edit with no old side: every line is an addition.
  const oldText = toolName === 'Write' ? '' : str(input, 'old_string');
  const newText = toolName === 'Write' ? str(input, 'content') : str(input, 'new_string');
  if (oldText === '' && newText === '') return [];
  const h = hunkOf(oldText, newText);
  return h.removed.length > 0 || h.added.length > 0 ? [h] : [];
}

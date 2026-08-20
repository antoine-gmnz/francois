// session-questions — pure question-card logic (FR-12/17/18/19/20/21), extracted
// from QuestionCard.tsx so selection accumulation, submit enablement, the ', '
// multi-select join, free-text pass-through and the FR-21 failure path are
// unit-testable without the DOM.

import type { QuestionOption, Result, SessionQuestion, SessionStatus } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';

/** Card-local answer state for one question section (parallel to `questions`). */
export interface SectionSelection {
  /** Chosen option labels — length ≤ 1 for single-select sections. */
  selected: string[];
  /** Committed free-text ("other…") answer; '' = none. Stored verbatim (FR-12). */
  freeText: string;
}

export function initSelections(questions: SessionQuestion[]): SectionSelection[] {
  return questions.map(() => ({ selected: [], freeText: '' }));
}

/**
 * FR-18: selections accumulate per section. Single-select replaces (and clears
 * any committed free text — one answer per section); multi-select toggles and
 * coexists with a committed free text.
 */
export function pickOption(
  questions: SessionQuestion[],
  sel: SectionSelection[],
  sectionIdx: number,
  label: string,
): SectionSelection[] {
  const q = questions[sectionIdx];
  if (!q) return sel;
  return sel.map((s, i) => {
    if (i !== sectionIdx) return s;
    if (!q.multiSelect) return { selected: [label], freeText: '' };
    return s.selected.includes(label)
      ? { ...s, selected: s.selected.filter((l) => l !== label) }
      : { ...s, selected: [...s.selected, label] };
  });
}

/**
 * §3 flow 4: a non-empty value counts as the section's answer. The value is
 * stored verbatim (FR-12) — only the non-emptiness gate trims. Whitespace-only
 * commits are a no-op. Single-select: free text replaces a picked option.
 */
export function commitFreeText(
  questions: SessionQuestion[],
  sel: SectionSelection[],
  sectionIdx: number,
  text: string,
): SectionSelection[] {
  const q = questions[sectionIdx];
  if (!q || text.trim() === '') return sel;
  return sel.map((s, i) => {
    if (i !== sectionIdx) return s;
    return q.multiSelect ? { ...s, freeText: text } : { selected: [], freeText: text };
  });
}

// ---------- design 13c: recommendation ----------

/**
 * The AskUserQuestion convention for "I recommend this one" — a trailing
 * `(Recommended)` on the option label. The core lifts it into
 * `QuestionOption.recommended` (control.rs), but the same test runs here too:
 * question blocks persisted before that flag existed replay from disk with only
 * the marker, and they must still read as recommended.
 */
export function isRecommendedLabel(label: string): boolean {
  return /\(\s*recommended\s*\)\s*$/i.test(label);
}

export function isRecommended(o: QuestionOption): boolean {
  return o.recommended === true || isRecommendedLabel(o.label);
}

/**
 * 13c strips the marker from the rendered label — the badge-free variant states
 * the recommendation with the row's own treatment instead. The raw `label` stays
 * the answer value everywhere else (FR-12), so this is display-only. A label that
 * is nothing BUT the marker keeps it, rather than rendering as an empty row.
 */
export function displayLabel(label: string): string {
  const stripped = label.replace(/\s*\(\s*recommended\s*\)\s*$/i, '').trim();
  return stripped === '' ? label : stripped;
}

/** The recommended option's raw label for one section; null when none is marked. */
export function recommendedLabel(q: SessionQuestion): string | null {
  return q.options.find(isRecommended)?.label ?? null;
}

/** How many sections carry a recommendation — the N in "Accept all N recommended". */
export function recommendedCount(questions: SessionQuestion[]): number {
  return questions.filter((q) => recommendedLabel(q) !== null).length;
}

/**
 * 13c header action: take my picks. Sections with a recommendation get it as
 * their sole selection (replacing whatever was picked, multi-select included —
 * "accept all recommended" means exactly the recommended set); sections without
 * one are left untouched, so a partial recommendation still leaves the card
 * honestly incomplete rather than silently answering for the user.
 */
export function acceptRecommended(
  questions: SessionQuestion[],
  sel: SectionSelection[],
): SectionSelection[] {
  return sel.map((s, i) => {
    const q = questions[i];
    if (!q) return s;
    const label = recommendedLabel(q);
    return label === null ? s : { selected: [label], freeText: '' };
  });
}

// ---------- design 13c: progress ----------

/** How many sections are answered — the "N answered" in the block header. */
export function answeredCount(sel: SectionSelection[]): number {
  return sel.filter(sectionComplete).length;
}

/**
 * The section the block is waiting on: the first incomplete one. -1 once every
 * section is answered (and for a resolved card, whose caller passes no picks).
 * 13c accents that section's ordinal and greys the rest, so a multi-question
 * block says where you are without a progress widget.
 */
export function currentSection(sel: SectionSelection[]): number {
  return sel.findIndex((s) => !sectionComplete(s));
}

/** 1-based section ordinal, zero-padded like the mock: `01`, `02`, … `10`. */
export function sectionOrdinal(i: number): string {
  return String(i + 1).padStart(2, '0');
}

export function sectionComplete(s: SectionSelection): boolean {
  return s.selected.length > 0 || s.freeText.trim() !== '';
}

export function allComplete(sel: SectionSelection[]): boolean {
  return sel.every(sectionComplete);
}

/** §8.6: the `answer ↵` affordance exists iff a multi-select section exists. */
export function hasMultiSelect(questions: SessionQuestion[]): boolean {
  return questions.some((q) => q.multiSelect);
}

/**
 * FR-18: on a pure single-select card the click/commit that completes the last
 * section submits. Any multi-select section defers to the `answer ↵` affordance
 * (a click can never be known to be the last toggle).
 */
export function shouldAutoSubmit(questions: SessionQuestion[], sel: SectionSelection[]): boolean {
  return !hasMultiSelect(questions) && allComplete(sel);
}

/**
 * FR-12: answers pass verbatim — one entry per section keyed by the question
 * text. Single-select: the label or the free text. Multi-select: selected
 * labels in option order joined with ', ', committed free text last.
 */
export function buildAnswers(questions: SessionQuestion[], sel: SectionSelection[]): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const s = sel[i] ?? { selected: [], freeText: '' };
    if (!q.multiSelect) {
      answers[q.question] = s.selected[0] ?? s.freeText;
      return;
    }
    const parts = q.options.map((o) => o.label).filter((l) => s.selected.includes(l));
    if (s.freeText.trim() !== '') parts.push(s.freeText);
    answers[q.question] = parts.join(', ');
  });
  return answers;
}

/**
 * FR-19: reconstruct the chosen rows of an answered card from the persisted
 * answer string (hydration has no card-local state). Best-effort for
 * multi-select: split the ', ' join, match option labels, echo the rest in the
 * free-text slot.
 */
export function answeredSelection(
  question: SessionQuestion,
  answer: string | undefined,
): { chosen: string[]; freeText: string | null } {
  if (answer === undefined) return { chosen: [], freeText: null };
  const labels = question.options.map((o) => o.label);
  if (!question.multiSelect) {
    return labels.includes(answer) ? { chosen: [answer], freeText: null } : { chosen: [], freeText: answer };
  }
  const parts = answer.split(', ');
  const chosen = parts.filter((p) => labels.includes(p));
  const rest = parts.filter((p) => !labels.includes(p));
  return { chosen, freeText: rest.length > 0 ? rest.join(', ') : null };
}

// ---------- submit flow (FR-18/21) ----------

export interface SubmitAnswersArgs {
  /** buildAnswers output for the completed card. */
  answers: Record<string, string>;
  /** Bound francois:session:answerQuestion call. */
  answer: (answers: Record<string, string>) => Promise<Result<null>>;
  /** Card in-flight flag (opacity 0.7 + clicks ignored while true). */
  setInFlight: (v: boolean) => void;
  /** true when the block was already resolved by an event (§3 flow 8 race). */
  isResolved: () => boolean;
  /** console.error injection point. */
  log: (message: string) => void;
}

/**
 * FR-18: one answerQuestion call; further clicks are ignored while in flight.
 * On success the card STAYS in-flight — the question.resolved event flips it to
 * its answered state. FR-21: a failure (ok: false or a transport rejection)
 * logs to the console and re-enables the card unless an event already resolved
 * it — never an alert, never a stuck disabled card.
 */
export async function submitAnswers(a: SubmitAnswersArgs): Promise<void> {
  a.setInFlight(true);
  let failure: string | null = null;
  try {
    const res = await a.answer(a.answers);
    if (!res.ok) failure = res.error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (failure !== null) {
    a.log(`answerQuestion failed: ${failure}`);
    if (!a.isResolved()) a.setInFlight(false);
  }
}

// ---------- composer placeholder (FR-20) ----------

/** True while any pending question card exists in the visible transcript. */
export function hasPendingQuestionBlock(blocks: ConversationBlock[]): boolean {
  return blocks.some((b) => b.kind === 'question' && b.state === 'pending');
}

/**
 * FR-20: the composer placeholder swaps while a pending card exists and
 * reverts when none is. Ended/errored sessions keep their placeholders (a dead
 * turn has no pending questions anyway — FR-13).
 *
 * permission-guardrails FR-23 adds the approval hint on the same line. A pending
 * QUESTION wins over a pending approval so the two hints never fight; both mean
 * "the turn is parked and typed messages queue", which is the part that matters.
 */
export function composerPlaceholder(
  status: SessionStatus,
  errorMessage: string | undefined,
  pendingQuestion: boolean,
  pendingPermission = false,
): string {
  if (status === 'done') return 'session ended — press n for a new one';
  if (status === 'error') return errorMessage || 'session error';
  if (pendingQuestion) return 'answer the question above — typed messages will queue';
  if (pendingPermission) return 'approve or deny the request above — typed messages will queue';
  return 'send a follow-up, or run a command…';
}

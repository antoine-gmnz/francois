// DIFF tab "Mark reviewed" (Figma 135:5022): a reviewer's own tick per changed
// file, feeding the review bar's "N files · M reviewed" and its meter. Pure UI
// state — in memory, per session, never persisted and never sent anywhere.
//
// A mark is keyed on the file's SHAPE (path + status + line counts), not its
// path alone: when the agent edits a file you already reviewed, its counts move
// and the tick falls off on its own — which is exactly when it needs a second look.

import { create } from 'zustand';
import type { SessionId } from '../../../contract/common';
import type { DiffFileSummary } from '../../../contract/diff-view';

export function reviewKey(file: DiffFileSummary): string {
  return `${file.path}\u0000${file.status}\u0000${file.additions}\u0000${file.deletions}`;
}

export function isReviewed(marks: readonly string[], file: DiffFileSummary): boolean {
  return marks.includes(reviewKey(file));
}

export function toggleReviewed(marks: readonly string[], file: DiffFileSummary): string[] {
  const key = reviewKey(file);
  return marks.includes(key) ? marks.filter((k) => k !== key) : [...marks, key];
}

export interface ReviewProgress {
  reviewed: number;
  total: number;
  /** 0–1, for the review bar's meter. */
  fraction: number;
}

export function reviewProgress(files: readonly DiffFileSummary[], marks: readonly string[]): ReviewProgress {
  const set = new Set(marks);
  const reviewed = files.filter((f) => set.has(reviewKey(f))).length;
  const total = files.length;
  return { reviewed, total, fraction: total === 0 ? 0 : reviewed / total };
}

const NO_MARKS: readonly string[] = [];

interface DiffReviewState {
  bySession: Record<SessionId, string[]>;
  toggle: (sessionId: SessionId, file: DiffFileSummary) => void;
}

export const useDiffReviewStore = create<DiffReviewState>((set) => ({
  bySession: {},
  toggle: (sessionId, file) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: toggleReviewed(s.bySession[sessionId] ?? NO_MARKS, file) } })),
}));

/** The session's review marks (a stable empty array when it has none). */
export function useReviewMarks(sessionId: SessionId): readonly string[] {
  return useDiffReviewStore((s) => s.bySession[sessionId] ?? NO_MARKS);
}

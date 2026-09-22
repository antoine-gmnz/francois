// Graphite & Signal (Figma 02–03) — the question card's step flow and the
// compact answered record. Pure logic only (no DOM).

import { describe, expect, it } from 'vitest';
import type { SessionQuestion } from '../../../contract/common';
import {
  advanceStep,
  answerSummary,
  initialSelections,
  initSelections,
  isRecommendedSelection,
  pickOption,
  questionHeading,
  setFreeText,
} from './question-card';

const branch: SessionQuestion = {
  question: 'Which base branch?',
  header: 'Branch',
  multiSelect: false,
  options: [
    { label: 'main', description: 'every PR', recommended: true },
    { label: 'develop', description: 'only develop' },
  ],
};
const plain: SessionQuestion = {
  question: 'Which region?',
  header: 'Region',
  multiSelect: false,
  options: [
    { label: 'eu', description: '' },
    { label: 'us', description: '' },
  ],
};
const multi: SessionQuestion = {
  question: 'Which checks?',
  header: 'Checks',
  multiSelect: true,
  options: [
    { label: 'lint', description: '' },
    { label: 'test (Recommended)', description: '' },
  ],
};

describe('initialSelections (Figma 02: the recommended row starts selected)', () => {
  it('preselects each recommendation and leaves the rest empty', () => {
    expect(initialSelections([branch, plain])).toEqual([
      { selected: ['main'], freeText: '' },
      { selected: [], freeText: '' },
    ]);
    expect(initialSelections([multi])).toEqual([{ selected: ['test (Recommended)'], freeText: '' }]);
  });
});

describe('isRecommendedSelection', () => {
  it('is true only while the picks equal the recommended set', () => {
    const qs = [branch];
    expect(isRecommendedSelection(qs, initialSelections(qs))).toBe(true);
    expect(isRecommendedSelection(qs, pickOption(qs, initialSelections(qs), 0, 'develop'))).toBe(false);
    expect(isRecommendedSelection([plain], initSelections([plain]))).toBe(false);
  });
});

describe('setFreeText (the always-open "Something else" field)', () => {
  it('replaces a single-select pick while it holds text, and clears on empty', () => {
    const qs = [branch];
    const typed = setFreeText(qs, initialSelections(qs), 0, 'release');
    expect(typed).toEqual([{ selected: [], freeText: 'release' }]);
    expect(setFreeText(qs, typed, 0, '')).toEqual([{ selected: [], freeText: '' }]);
  });

  it('keeps multi-select picks alongside the text', () => {
    const qs = [multi];
    expect(setFreeText(qs, [{ selected: ['lint'], freeText: '' }], 0, 'e2e')).toEqual([{ selected: ['lint'], freeText: 'e2e' }]);
  });

  it('whitespace does not displace a pick', () => {
    const qs = [branch];
    expect(setFreeText(qs, initialSelections(qs), 0, '  ')).toEqual([{ selected: ['main'], freeText: '  ' }]);
  });

  it('is a no-op when the question disallows free text', () => {
    const closed = { ...plain, isOther: false };
    const sel = initSelections([closed]);
    expect(setFreeText([closed], sel, 0, 'x')).toBe(sel);
  });
});

describe('advanceStep (Answer / Next)', () => {
  it('blocks while the shown question is unanswered', () => {
    expect(advanceStep(initSelections([plain]), 0)).toEqual({ kind: 'blocked' });
  });

  it('moves to the next unanswered question, then submits', () => {
    const first = { selected: ['main'], freeText: '' };
    expect(advanceStep([first, { selected: [], freeText: '' }], 0)).toEqual({ kind: 'next', step: 1 });
    expect(advanceStep([first, { selected: ['eu'], freeText: '' }], 1)).toEqual({ kind: 'submit' });
  });

  it('wraps back to an earlier unanswered question before submitting', () => {
    const sel = [
      { selected: [], freeText: '' },
      { selected: ['eu'], freeText: '' },
    ];
    expect(advanceStep(sel, 1)).toEqual({ kind: 'next', step: 0 });
  });
});

describe('questionHeading', () => {
  it('reads "Question · N of M"', () => {
    expect(questionHeading(0, 1)).toBe('Question · 1 of 1');
    expect(questionHeading(1, 3)).toBe('Question · 2 of 3');
  });
});

describe('answerSummary (Figma 03: "main · recommended")', () => {
  it('names the picked option and flags a recommendation', () => {
    expect(answerSummary(branch, 'main')).toEqual({ text: 'main', recommended: true });
    expect(answerSummary(branch, 'develop')).toEqual({ text: 'develop', recommended: false });
  });

  it('strips the marker and joins multi-select picks with free text', () => {
    expect(answerSummary(multi, 'lint, test (Recommended), e2e')).toEqual({ text: 'lint, test, e2e', recommended: false });
    expect(answerSummary(multi, 'test (Recommended)')).toEqual({ text: 'test', recommended: true });
  });

  it('echoes a free-text answer and redacts secrets', () => {
    expect(answerSummary(plain, 'ap-south')).toEqual({ text: 'ap-south', recommended: false });
    expect(answerSummary({ ...plain, isSecret: true }, 'hunter2')).toEqual({ text: '[redacted]', recommended: false });
    expect(answerSummary(plain, undefined)).toEqual({ text: '', recommended: false });
  });
});

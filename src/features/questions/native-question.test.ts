import { expect, it } from 'vitest';
import { answeredSelection, buildAnswers, commitFreeText, hasPendingQuestionBlock, initSelections } from './question-card';
import type { SessionQuestion } from '../../../contract/common';
const question = (id: string): SessionQuestion => ({ id, question: 'Same text', header: 'Choice', options: [], multiSelect: false });
it('keys equal displayed questions by opaque ids and preserves legacy text keys', () => {
  const qs = [question('first'), question('second'), { ...question('legacy'), id: undefined }];
  expect(buildAnswers(qs, qs.map((_, i) => ({ selected: [], freeText: String(i) })))).toEqual({ first: '0', second: '1', 'Same text': '2' });
});
it('rejects invented Other with options but permits a no-options freeform answer', () => {
  const q = { ...question('q'), isOther: false, options: [{ label: 'Yes', description: '' }] };
  const initial = initSelections([q]);
  expect(commitFreeText([q], initial, 0, 'Other')).toBe(initial);
  expect(commitFreeText([{ ...q, options: [] }], initial, 0, 'text')[0].freeText).toBe('text');
});
it('never reconstructs a secret chosen option or raw text', () => {
  const q = { ...question('secret'), isSecret: true };
  expect(answeredSelection(q, 'SENTINEL')).toEqual({ chosen: [], freeText: '[redacted]' });
});
it('nonblocking pending questions do not park the composer', () => {
  expect(hasPendingQuestionBlock([{ kind: 'question', blockId: 'q', isStreaming: true, state: 'pending', questions: [], blocking: false }])).toBe(false);
});

it('preserves prototype-shaped opaque question ids as own serialized keys', () => {
  const answers = buildAnswers([question('__proto__'), question('constructor')], [{ selected: ['one'], freeText: '' }, { selected: ['two'], freeText: '' }]);
  expect(JSON.parse(JSON.stringify(answers))).toEqual({ ['__proto__']: 'one', constructor: 'two' });
});

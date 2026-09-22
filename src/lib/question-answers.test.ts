import { expect, it } from 'vitest';
import type { SessionQuestion } from '../../contract/common';
import { questionAnswerKey, redactAnswers } from './question-answers';

const question = (id?: string): SessionQuestion => ({ id, question: 'Same text', header: 'Choice', options: [], multiSelect: false });

it('preserves opaque keys including empty and prototype-shaped ids, falling back only when absent', () => {
  expect(['first', 'second', '', '__proto__', 'constructor'].map(id => questionAnswerKey(question(id)))).toEqual(['first', 'second', '', '__proto__', 'constructor']);
  expect(questionAnswerKey(question())).toBe('Same text');
});

it('redacts secret answers without mutating the source or exposing prototype-shaped keys', () => {
  const original = JSON.parse('{"secret":"SENTINEL","__proto__":"SENTINEL","public":"visible"}') as Record<string, string>;
  const safe = redactAnswers([{ ...question('secret'), isSecret: true }, { ...question('__proto__'), isSecret: true }, question('public')], original);
  expect(JSON.parse(JSON.stringify(safe))).toEqual({ secret: '[redacted]', ['__proto__']: '[redacted]', public: 'visible' });
  expect(original.secret).toBe('SENTINEL');
  expect(original.__proto__).toBe('SENTINEL');
});

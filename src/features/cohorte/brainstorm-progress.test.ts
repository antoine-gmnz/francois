import { describe, expect, it } from 'vitest';
import type { CohorteBrainstormTurn } from '../../../contract/cohorte-actions';
import { brainstormReplyFields, brainstormStartLines, CONTINUE_MESSAGE, elapsedLabel } from './brainstorm-progress';

const turnWith = (blocking: string[]) => ({ brief: { synthesis: { blocking_questions: blocking } } }) as unknown as CohorteBrainstormTurn;

describe('brainstormReplyFields', () => {
  it('continues with the fixed carry-on message when the reply is empty', () => {
    expect(brainstormReplyFields('  ', 'message', null, 'continue')).toEqual({ message: CONTINUE_MESSAGE });
    expect(brainstormReplyFields('', 'answer', turnWith(['Q?']), 'continue')).toEqual({ message: CONTINUE_MESSAGE });
  });

  it('sends nothing for an intake or a new idea without a reply', () => {
    expect(brainstormReplyFields('', 'message', null, 'intake')).toEqual({});
    expect(brainstormReplyFields('', 'message', null, undefined)).toEqual({});
  });

  it('sends a typed reply as a message', () => {
    expect(brainstormReplyFields(' why? ', 'message', null, 'continue')).toEqual({ message: 'why?' });
  });

  it('prefixes a decision with the lone blocking question it answers', () => {
    expect(brainstormReplyFields('yes', 'answer', turnWith(['Q?']), 'continue')).toEqual({ answer: 'Q? yes' });
    expect(brainstormReplyFields('Q? yes', 'answer', turnWith(['Q?']), 'continue')).toEqual({ answer: 'Q? yes' });
    expect(brainstormReplyFields('yes', 'answer', turnWith(['A?', 'B?']), 'continue')).toEqual({ answer: 'yes' });
  });
});

describe('elapsedLabel', () => {
  it('reads seconds, then minutes and padded seconds', () => {
    expect(elapsedLabel(42_900)).toBe('42 s');
    expect(elapsedLabel(185_000)).toBe('3 min 05 s');
    expect(elapsedLabel(-5)).toBe('0 s');
  });
});

describe('brainstormStartLines', () => {
  it('names the perspectives at work, falling back to their ids', () => {
    const lines = brainstormStartLines(1, 'cohorte brainstorm --continue x', ['ux', 'data'], { ux: 'Expérience' });
    expect(lines.map(line => line.text)).toEqual([
      'Lancement : cohorte brainstorm --continue x',
      'Le panel lit le projet en lecture seule',
      'Perspectives au travail : Expérience, data',
    ]);
  });

  it('falls back to a generic line without perspectives', () => {
    expect(brainstormStartLines(1, 'cohorte brainstorm', [], {})[2].text).toBe('Le panel brainstorm travaille');
  });
});

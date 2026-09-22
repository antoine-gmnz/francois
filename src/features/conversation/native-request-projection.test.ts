import { expect, it } from 'vitest';
import { transcriptReducer } from './conversation-blocks';
import type { QuestionConversationBlock } from '../../../contract/session-questions';
const INITIAL_TRANSCRIPT = { blocks: [], windowSize: 100 };
const questions = [{ id: 'opaque', header: 'Token', question: 'Token?', isSecret: true, isOther: false, options: [], multiSelect: false }];
it('preserves native metadata and redacts resolved and reloaded secret answers', () => {
  let state = transcriptReducer(INITIAL_TRANSCRIPT, { t: 'questionAsked', blockId: 'q', questions, blocking: false });
  expect(state.blocks[0]).toMatchObject({ questions, blocking: false });
  state = transcriptReducer(state, { t: 'questionResolved', blockId: 'q', state: 'answered', answers: { opaque: 'SENTINEL' } });
  expect(JSON.stringify(state)).not.toContain('SENTINEL');
  expect(state.blocks[0]).toMatchObject({ blocking: false, answers: { opaque: '[redacted]' } });
  const saved: QuestionConversationBlock = { kind: 'question', blockId: 'saved', isStreaming: false, state: 'answered', questions, answers: { opaque: 'SENTINEL' } };
  expect(JSON.stringify(transcriptReducer(INITIAL_TRANSCRIPT, { t: 'seed', blocks: [saved] }))).not.toContain('SENTINEL');
  expect(JSON.stringify(transcriptReducer(INITIAL_TRANSCRIPT, { t: 'prepend', blocks: [saved] }))).not.toContain('SENTINEL');
});

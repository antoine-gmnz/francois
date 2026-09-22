// contract/session-questions.ts — question cards (AskUserQuestion over the
// stdio control channel). Authored from specs/session-questions.md §5.
// Shapes mirror the CLI's AskUserQuestion input verbatim — do not "improve" them.
//
// Physical Tauri binding: `francois:session:answerQuestion` → command
// `session_answer_question`. Events ride francois://session/event (common.ts).
//
// SessionQuestion/QuestionOption are shared vocabulary (the SessionEvent union
// in common.ts needs them, and common.ts never imports from feature files), so
// they are DECLARED in common.ts and re-exported here (spec §5.3 placement rule).

import type { BlockId, SessionId } from './common';

export type { QuestionOption, SessionQuestion } from './common';
import type { SessionQuestion } from './common';

export type QuestionState = 'pending' | 'answered' | 'cancelled';

export interface QuestionConversationBlock {
  kind: 'question';
  blockId: BlockId;
  /** true iff state === 'pending' (FR-15). */
  isStreaming: boolean;
  questions: SessionQuestion[];
  /** Absent means blocking (legacy); false allows native progress while displayed. */
  blocking?: boolean;
  state: QuestionState;
  /** Answer key (question.id or legacy question text) → answer; secrets are [redacted]. */
  answers?: Record<string, string>;
}

export interface AnswerQuestionRequest {
  sessionId: SessionId;
  blockId: BlockId;
  /** question.id when present, otherwise question text → label/free text/legacy multi-select. */
  answers: Record<string, string>;
}

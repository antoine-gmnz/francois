import type { SessionQuestion } from '../../contract/common';

export function questionAnswerKey(question: SessionQuestion): string {
  return question.id ?? question.question;
}

/** Defense in depth for live/reloaded projections; raw secrets stay in form/IPC only. */
export function redactAnswers(questions: SessionQuestion[], answers: Record<string, string>): Record<string, string> {
  const safe = { ...answers };
  for (const q of questions) {
    const key = questionAnswerKey(q);
    if (q.isSecret && Object.prototype.hasOwnProperty.call(safe, key)) safe[key] = '[redacted]';
  }
  return safe;
}


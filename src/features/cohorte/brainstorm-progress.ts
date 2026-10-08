// Brainstorm sheet — the pure half of "continue where it left off" and of the
// activity log shown while the panel works. The CLI refuses a bare
// `brainstorm --continue <id>` (it needs --message or --answer), so an empty
// reply on a continued brainstorm sends a fixed "carry on" message instead.

import type { CohorteBrainstormTurn } from '../../../contract/cohorte-actions';

export const CONTINUE_MESSAGE = 'Reprenez là où vous vous êtes arrêtés : approfondissez les points encore ouverts et proposez la suite.';

export type BrainstormReplyKind = 'message' | 'answer';

/** The `message`/`answer` half of a brainstorm request. */
export function brainstormReplyFields(
  reply: string,
  kind: BrainstormReplyKind,
  turn: CohorteBrainstormTurn | null,
  source: 'intake' | 'continue' | undefined,
): { message?: string; answer?: string } {
  const text = reply.trim();
  if (!text) return source === 'continue' ? { message: CONTINUE_MESSAGE } : {};
  if (kind === 'message') return { message: text };
  // A lone blocking question is prefixed so the decision reads on its own.
  const questions = turn?.brief.synthesis.blocking_questions ?? [];
  return { answer: questions.length === 1 && !text.includes(questions[0]) ? `${questions[0]} ${text}` : text };
}

export interface BrainstormLogLine {
  at: number;
  text: string;
}

/** `42 s`, `3 min 05 s` — the panel's elapsed time. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** `14:03:27` — a log line's wall-clock stamp. */
export function clockLabel(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** The opening lines of a panel run, before the CLI answers. */
export function brainstormStartLines(
  at: number,
  command: string,
  perspectives: string[],
  names: Record<string, string>,
): BrainstormLogLine[] {
  return [
    { at, text: `Lancement : ${command}` },
    { at, text: 'Le panel lit le projet en lecture seule' },
    {
      at,
      text: perspectives.length > 0
        ? `Perspectives au travail : ${perspectives.map(perspective => names[perspective] ?? perspective).join(', ')}`
        : 'Le panel brainstorm travaille',
    },
  ];
}

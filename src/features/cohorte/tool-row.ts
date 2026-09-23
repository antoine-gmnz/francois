// cohorte-integration FR-66 — a Bash tool call that runs the `cohorte` CLI
// renders as a Cohorte row: verb "Cohorte", target = the rest of the command,
// meta = the short run id its result printed. A launching verb that printed a
// run id is also FR-30's rule-1 evidence (`launched`). Pure, unit-tested.

import { shortRunId } from './run-view';

const LAUNCH_VERBS: ReadonlySet<string> = new Set(['run', 'loop', 'build', 'fix', 'review']);
const RUN_ID = /run_[0-9a-f]{6,32}/;

export interface CohorteToolRow {
  /** the command after the program, e.g. `run auth-retry --detach` */
  target: string;
  /** the short run id when the result printed one, else null (keep the row's own meta) */
  meta: string | null;
  /** the run ref to record as a `launched` link, when this call launched a run */
  launchedRef: string | null;
}

/** The argv after `cohorte` (or `npx [-y] cohorte`), or null when the first program is anything else. */
function cohorteArgs(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (tokens[i] === 'npx') {
    i += 1;
    while (tokens[i]?.startsWith('-')) i += 1;
  }
  const program = tokens[i];
  if (!program) return null;
  const base = program.split(/[\\/]/).pop();
  if (base !== 'cohorte' && base !== 'cohorte.cmd') return null;
  return tokens.slice(i + 1);
}

export function classifyCohorteTool(tool: string, command: string, result: string): CohorteToolRow | null {
  if (tool !== 'Bash') return null;
  const args = cohorteArgs(command);
  if (args === null) return null;
  const found = RUN_ID.exec(result)?.[0] ?? null;
  const verb = args[0] ?? '';
  return {
    target: args.join(' '),
    meta: found ? shortRunId(found) : null,
    launchedRef: found && LAUNCH_VERBS.has(verb) ? found : null,
  };
}

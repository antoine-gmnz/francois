// cohorte-integration FR-70 — the run view's main-pane tab id, `cohorte:<runId>`.
// Sibling of extensions' `ext:<id>`: app-scoped, never in a session's agentTabs.

const PREFIX = 'cohorte:';

export function cohorteTabId(runId: string): `cohorte:${string}` {
  return `${PREFIX}${runId}`;
}

/** The run behind a MainTab value, or null for any other tab. */
export function cohorteRunIdFromTab(tab: string): string | null {
  return tab.startsWith(PREFIX) ? tab.slice(PREFIX.length) : null;
}

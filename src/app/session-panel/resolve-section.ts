// Pure: which registered session-panel section to show. Split from sections.ts so
// it is testable without importing the section components (and their CSS).

/** cohorte-integration FR-67: a section may hide itself for a session. */
export function visibleSections<S, T extends { id: string; visible?: (session: S) => boolean }>(sections: readonly T[], session: S | null): T[] {
  return sections.filter((s) => !s.visible || (session !== null && s.visible(session)));
}

/** The persisted tab when it is registered (and visible), else the first visible section. */
export function resolveSection<S, T extends { id: string; visible?: (session: S) => boolean }>(
  sections: readonly T[],
  tab: string,
  session: S | null = null,
): T | null {
  const shown = visibleSections(sections, session);
  return shown.find((s) => s.id === tab) ?? shown[0] ?? null;
}

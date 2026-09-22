// Pure: which registered session-panel section to show. Split from sections.ts so
// it is testable without importing the section components (and their CSS).

/** The persisted tab when it is registered, else the first registered section. */
export function resolveSection<T extends { id: string }>(sections: readonly T[], tab: string): T | null {
  return sections.find((s) => s.id === tab) ?? sections[0] ?? null;
}

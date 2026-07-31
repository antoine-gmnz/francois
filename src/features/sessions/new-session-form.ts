// new-session-form — pure helpers shared by NewSessionModal's extracted
// hooks (useProjectDefaults derives the session name from a project's root;
// useDirectoryPicker derives it from a picked/typed path).

/** Last path segment, tolerant of both `/` and `\` separators. Falls back to
 * the input itself when it has no segments (e.g. an empty string). */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

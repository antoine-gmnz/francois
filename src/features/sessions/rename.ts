// session-rename — the pure commit gate the rename modal hangs off (FR-10).
// The core is the authority on names (validate_session_name, FR-1); this mirrors
// only the two rules the UI can enforce without a round-trip, so an obviously
// invalid name never becomes an IPC call.

/** FR-1: 80 Unicode scalar values, counted with `chars()` — not bytes, not UTF-16 units. */
export const SESSION_NAME_MAX = 80;

/** Scalar-value length, so an emoji counts as one character like it does in Rust. */
export function nameLength(name: string): number {
  return [...name.trim()].length;
}

/**
 * FR-10: the `Rename` button is enabled — and Enter commits — only while the
 * trimmed name is non-empty, within the cap, and no call is in flight.
 */
export function canCommitRename(name: string, submitting: boolean): boolean {
  if (submitting) return false;
  const len = nameLength(name);
  return len > 0 && len <= SESSION_NAME_MAX;
}

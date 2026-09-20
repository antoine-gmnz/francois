// deep-equal — structural value equality for the plain-JSON payloads that
// arrive over the Tauri boundary (SessionMeta and friends). It exists because
// the store's no-op guards used to compare `JSON.stringify(a) === JSON.stringify(b)`,
// which is both key-ORDER-sensitive (serde and a hand-built `{ ...session, … }`
// spread emit the same fields in different orders, so an identical payload read
// as a change) and costly: it serialises two whole objects on the hottest event
// in the app before it can find a difference in the first field.
//
// Deliberately narrow: JSON values only — no Date/Map/Set/RegExp/cycle
// handling, because nothing off the wire is one of those and a general
// structural comparator would be a bigger surface than any caller needs.

/**
 * True when `a` and `b` hold the same value, compared field by field and
 * element by element. Short-circuits on reference identity and on the first
 * difference found.
 *
 * An own key whose value is `undefined` reads as ABSENT — the semantics
 * `JSON.stringify` gave the callers this replaced, and load-bearing: a store
 * entry rebuilt as `{ ...session, effort: undefined }` must still compare equal
 * to the wire snapshot that simply omits `effort`, or the no-op guard mints a
 * new array for an unchanged payload.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let matched = 0;
  for (const key of Object.keys(left)) {
    const value = left[key];
    if (value === undefined) continue;
    if (!deepEqual(value, right[key])) return false;
    matched += 1;
  }
  // Only a counted walk of the other side can catch a key `left` does not have
  // at all; comparing `Object.keys` lengths would miscount the undefined ones.
  for (const key of Object.keys(right)) {
    if (right[key] === undefined) continue;
    matched -= 1;
  }
  return matched === 0;
}

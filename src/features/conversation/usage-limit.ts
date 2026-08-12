// The `USAGE_LIMIT` session.error — the account's plan window is exhausted.
//
// The core already decided this failure is transient: it fails the turn and
// sends the session back to `idle` (src-tauri/src/session/status.rs), because
// the window resets on its own clock and emits nothing when it does. All that
// is left here is saying so in a line the user can read — including the reset
// time, which the CLI hides in the message rather than in a field.

/** `Claude AI usage limit reached|1753272000` — the epoch the CLI appends. */
const EPOCH_SUFFIX = /\|\s*(\d{9,14})\s*$/;

/**
 * The moment the limit lifts, in epoch MILLIseconds, or null when the message
 * carries no timestamp. The CLI writes seconds; a 13-digit value is already ms
 * (tolerated so a future wording change does not read as a date in 1970).
 */
export function usageLimitResetAt(message: string): number | null {
  const m = EPOCH_SUFFIX.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 1e12 ? n : n * 1000;
}

/**
 * Weekday + time rather than time alone: the plan has a 5-hour window AND a
 * weekly one, and "resets at 11:00" for a reset four days out reads as a lie.
 */
function defaultFormatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * The banner line. `formatTime` is injectable so the wording can be tested
 * without a locale/timezone dependency.
 */
export function usageLimitNoticeText(message: string, formatTime: (at: number) => string = defaultFormatTime): string {
  const at = usageLimitResetAt(message);
  return at === null
    ? 'usage limit reached — this session stays open; send again once your plan window resets'
    : `usage limit reached — this session stays open; send again after ${formatTime(at)}`;
}

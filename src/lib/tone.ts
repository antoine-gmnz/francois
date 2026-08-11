// Theme-aware rendering of the contract's colour literals.
//
// Two contract files carry colours as raw hexes rather than tokens —
// `conversation-view.ts` (`glyphColor`/`bodyColor`, because the Rust core mirrors
// them and a CSS var cannot cross that boundary) and `fleet-board.ts`
// (`STATUS_COLOR`, whose values a test asserts are `#rrggbb`). Those literals are
// the DARK palette, so anything that renders them verbatim stays dark-themed under
// `data-theme='light'`: the assistant body reads gray-on-white, and the `active`
// status tag stays acid lime on a white bar.
//
// Every literal either map defines is, byte for byte, one of the dark tokens in
// src/styles.css — so map each back onto the token that owns it and let the theme
// resolve it. Dark renders pixel-identically (the token IS that hex); light gets
// the inverted ladder and the darkened accent/status hues for free.
const TONE: Record<string, string> = {
  // text ladder
  '#f2f4f8': 'var(--text-bright)',
  '#e6e9ef': 'var(--text-strong)',
  '#d6dae2': 'var(--text)',
  '#c3c9d4': 'var(--text-2)',
  '#9aa2b1': 'var(--text-hint)',
  '#8b93a3': 'var(--text-dim)',
  '#6b7385': 'var(--text-muted)',
  '#565e6e': 'var(--text-faint)',
  '#3a4049': 'var(--text-disabled)',
  // accent (acid) — light darkens these to #4e6a14 / #3e5510 / #6d8a2a
  '#c3f53f': 'var(--accent)',
  '#d6fa7e': 'var(--accent-bright)',
  '#8ea84a': 'var(--accent-dim)',
  // status hues
  '#d4c46f': 'var(--warn)',
  '#e0a84e': 'var(--attn)',
  '#4fae86': 'var(--success)',
  '#8bc292': 'var(--success-bright)',
  '#517a55': 'var(--success-dim)',
  '#d1685e': 'var(--error)',
  '#e0918a': 'var(--error-bright)',
  '#8f3f37': 'var(--error-dim)',
  // families
  '#b39ede': 'var(--hue-purple)',
  '#cbb9ec': 'var(--hue-purple-soft)',
  '#8fbab8': 'var(--hue-teal)',
  '#6f9fd8': 'var(--hue-blue)',
  '#7c8aa0': 'var(--hue-slate)',
};

/**
 * Theme-aware color for a contract colour literal. Values that are already a
 * `var(--…)` (several call sites fall back to one) and any unmapped colour pass
 * through untouched, so a colour the contract adds later still renders — dark-only
 * — instead of disappearing.
 */
export function toneVar(color: string): string {
  return TONE[color.toLowerCase()] ?? color;
}

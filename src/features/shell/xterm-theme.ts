// The xterm.js theme, resolved from the app's CSS variables.
//
// Shared by the SHELL tab and multi-account's embedded login terminal (FR-12),
// which renders the real `claude` onboarding TUI and must look identical to the
// SHELL tab. It lives here, next to the tab that owns the idiom.
//
// Graphite & Signal (Figma 136:5760 / 142:13150): the terminal sits on its own
// surface, `--bg-terminal`, one step below the canvas. Prompt paths read green,
// branches blue, commands in primary text, output in secondary — so the ANSI
// palette maps onto the state tokens rather than on decorative hues.

import type { ITheme } from '@xterm/xterm';

/** xterm renders to a canvas and CANNOT resolve CSS var(...) — so every colour
 *  is named here as a token and resolved to a concrete string at runtime. */
export const XTERM_THEME_TOKENS = {
  background: '--bg-terminal',
  foreground: '--text-primary',
  cursor: '--text-primary',
  cursorAccent: '--bg-terminal',
  black: '--bg-raised',
  red: '--state-danger',
  green: '--state-success',
  yellow: '--warn',
  blue: '--state-info',
  magenta: '--state-attention',
  cyan: '--state-running',
  white: '--text-secondary',
  brightBlack: '--text-faint',
  brightRed: '--state-danger-text',
  brightGreen: '--state-success-text',
  brightYellow: '--warn',
  brightBlue: '--state-info',
  brightMagenta: '--state-attention-text',
  brightCyan: '--state-running',
  brightWhite: '--text-primary',
} as const satisfies Partial<Record<keyof ITheme, string>>;

/** The selection is the state-info blue at this alpha — visible on both themes'
 *  terminal surfaces without hiding the glyphs under it. */
export const SELECTION_ALPHA = 0.3;
const SELECTION_FALLBACK = 'rgba(122, 162, 247, 0.3)';

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → `rgba(r, g, b, alpha)`; any existing alpha
 *  is replaced. Null for anything that is not a hex colour. */
export function hexWithAlpha(hex: string, alpha: number): string | null {
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  let rgb: string;
  if (h.length === 3) rgb = h.split('').map((c) => c + c).join('');
  else if (h.length === 6 || h.length === 8) rgb = h.slice(0, 6);
  else return null;
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Resolve the token table through `read` (a CSS-variable lookup). Pure, so the
 *  mapping is testable without a DOM. */
export function resolveTheme(read: (token: string) => string): ITheme {
  const theme: ITheme = {};
  for (const [key, token] of Object.entries(XTERM_THEME_TOKENS)) {
    (theme as Record<string, string>)[key] = read(token);
  }
  theme.selectionBackground = hexWithAlpha(read('--state-info'), SELECTION_ALPHA) ?? SELECTION_FALLBACK;
  return theme;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Full xterm theme (base + ANSI 16-colour mapping — shell-terminal §8 FR-24),
 *  read from the live CSS variables. Rebuild on each light/dark switch. */
export function buildTheme(): ITheme {
  return resolveTheme(cssVar);
}

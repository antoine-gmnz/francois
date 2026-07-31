// The xterm.js theme, resolved from the app's CSS variables.
//
// Extracted from ShellTerminal.tsx verbatim so a SECOND terminal can share it:
// multi-account's embedded login terminal (FR-12) renders the real `claude`
// onboarding TUI and must look identical to the SHELL tab — the design brief
// pins "the same theme object the SHELL tab uses". It lives here, next to the
// tab that owns the idiom, rather than in src/lib (which holds only what every
// feature imports).

import type { ITheme } from '@xterm/xterm';

// xterm renders to a canvas and CANNOT resolve CSS var(...)/color-mix(...) — so
// every theme color is resolved to a concrete string at runtime from the CSS
// variables (owned by src/styles.css). Rebuild on each light/dark switch.
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Selection tint = the accent at 25% (design-refresh FR-13, updated for the
// "acid" accent swap: new --accent #c3f53f → rgba(195,245,63,0.25)). The
// accent resolves to a hex, so convert to rgba to keep the alpha the theme
// can't carry.
function accentSelection(): string {
  const h = cssVar('--accent').replace('#', '');
  if (h.length < 6) return 'rgba(195,245,63,0.25)';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.25)`;
}

/** Full xterm theme (base + ANSI 16-color mapping — shell-terminal §8 FR-24). */
export function buildTheme(): ITheme {
  return {
    background: cssVar('--bg-app'),
    foreground: cssVar('--text-bright'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--bg-app'),
    selectionBackground: accentSelection(),
    black: cssVar('--bg-panel'),
    red: cssVar('--error'),
    green: cssVar('--success'),
    yellow: cssVar('--accent'),
    blue: cssVar('--text-hint'),
    magenta: cssVar('--hue-purple-soft'),
    cyan: cssVar('--hue-teal'),
    white: cssVar('--text'),
    brightBlack: cssVar('--text-muted'),
    brightRed: cssVar('--error-bright'),
    brightGreen: cssVar('--success-bright'),
    brightYellow: cssVar('--accent-2'),
    brightBlue: cssVar('--text-strong'),
    brightMagenta: cssVar('--hue-purple-soft'),
    brightCyan: cssVar('--hue-teal'),
    brightWhite: cssVar('--text-bright'),
  };
}

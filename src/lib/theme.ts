// theme store slice: light/dark theme (§theme). Split out of the former
// monolithic store.ts — see store.ts for the composition root.
//
// The mechanism (redesign "Graphite & Signal"): the theme is ONE attribute,
// `data-theme="dark" | "light"` on <html>. src/styles.css defines every token
// under :root (dark, the default) and re-points them under
// :root[data-theme='light']; nothing else in the app knows which theme is on.
// main.tsx applies the persisted value BEFORE first paint (readStoredTheme +
// applyTheme — the store does not exist yet at that point), and the slice below
// keeps it in step at runtime. Persisted to localStorage under THEME_KEY.

import type { StateCreator } from 'zustand';
import type { AppState } from './store';

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'francois.theme';

/** Only an exact 'light' is light — anything else (absent, garbled) is the dark default. */
export function parseTheme(raw: string | null): Theme {
  return raw === 'light' ? 'light' : 'dark';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** The persisted theme. Degrades to 'dark' if storage throws (restricted env / node test env). */
export function readStoredTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** Write `data-theme` on <html>. Guarded so the node test env (no `document`) does not crash. */
export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

export interface ThemeSlice {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

export const createThemeSlice: StateCreator<AppState, [], [], ThemeSlice> = (set) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    persistTheme(theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const theme = nextTheme(s.theme);
      persistTheme(theme);
      applyTheme(theme);
      return { theme };
    }),
});

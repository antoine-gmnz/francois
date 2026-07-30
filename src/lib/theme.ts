// theme store slice: light/dark theme (§theme). Split out of the former
// monolithic store.ts — see store.ts for the composition root. Initialized from
// localStorage; setter/toggle both persist and apply data-theme to <html>.

import type { StateCreator } from 'zustand';
import type { AppState } from './store';

export type Theme = 'light' | 'dark';
const THEME_KEY = 'francois.theme';

// Theme persistence. Degrades to 'dark' if storage throws (restricted env / node
// test env). The DOM write is guarded so the node test env (no `document`) does
// not crash.
function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
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
function applyTheme(theme: Theme): void {
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
  theme: loadTheme(),
  setTheme: (theme) => {
    persistTheme(theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === 'dark' ? 'light' : 'dark';
      persistTheme(theme);
      applyTheme(theme);
      return { theme };
    }),
});

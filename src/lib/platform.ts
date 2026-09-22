// platform — the one place that reads navigator for OS detection, so every
// feature that needs to gate WSL-only UI (session-engine's runtime field is
// Windows-only) checks the same value.
//
// The `typeof` guard is for vitest, not the app: the webview always has a
// navigator, but the test environment is `node`, where the global only exists
// from Node 21 — CI runs Node 20, so an unguarded read fails every test file
// that imports this module, however indirectly.

export const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

// rework-topbar: macOS keeps its native caption (traffic lights); Windows/Linux
// go frameless and draw WindowControls.tsx instead — this is the one gate both
// the frontend render and the platform pick read.
export const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

/**
 * True only inside a real Tauri webview. `@tauri-apps/api/window`'s
 * `getCurrentWindow()` reads `window.__TAURI_INTERNALS__` synchronously and
 * throws without it — absent from `npm run dev`'s plain vite/browser tab and
 * from the `__FRANCOIS_DEMO__` screenshot build, neither of which has a real
 * window to control. A function (not a module-scoped const like IS_WINDOWS/
 * IS_MAC) because Tauri injects this after the page's first script runs.
 */
export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// platform — the one place that reads navigator for OS detection, so every
// feature that needs to gate WSL-only UI (session-engine's runtime field is
// Windows-only) checks the same value.
//
// The `typeof` guard is for vitest, not the app: the webview always has a
// navigator, but the test environment is `node`, where the global only exists
// from Node 21 — CI runs Node 20, so an unguarded read fails every test file
// that imports this module, however indirectly.

export const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

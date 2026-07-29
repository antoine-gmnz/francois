// platform — the one place that reads navigator for OS detection, so every
// feature that needs to gate WSL-only UI (session-engine's runtime field is
// Windows-only) checks the same value.

export const IS_WINDOWS = navigator.userAgent.includes('Windows');

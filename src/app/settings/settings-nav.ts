// The Settings view's routing (redesign "Graphite & Signal", Settings 21–23).
//
// Settings replaced three modals, and every entry point in the app still raises
// one of their store flags — the gear and ⌘K raise `projectsOpen`, the avatar,
// the account chip and ⌘K raise `accountsOpen`. Rather than rewire every caller,
// the flags stay the source of truth for "Settings is open, and on which half":
//
//   projectsOpen → a PROJECT page (General, MCP servers — the sub-page is local)
//   accountsOpen → the Accounts page
//
// Keeping a flag up while Settings is open is also what keeps the app-wide
// single-letter shortcuts suppressed (useAppShortcuts / useSidebarKeyboard /
// useShellShortcuts all read them). Navigating sets exactly one flag
// (`flagsForPage`); a flag raised from elsewhere while open is a new request
// and wins (`resolveSettingsPage`).

export type SettingsPage = 'general' | 'mcp' | 'accounts';

export interface SettingsFlags {
  projectsOpen: boolean;
  accountsOpen: boolean;
}

export function isSettingsOpen(flags: SettingsFlags): boolean {
  return flags.projectsOpen || flags.accountsOpen;
}

export function isProjectPage(page: SettingsPage | null): boolean {
  return page === 'general' || page === 'mcp';
}

/** Which page shows after the flags moved from `prev` to `next`. */
export function resolveSettingsPage(prev: SettingsFlags, next: SettingsFlags, current: SettingsPage | null): SettingsPage | null {
  if (next.accountsOpen && !prev.accountsOpen) return 'accounts';
  if (next.projectsOpen && !prev.projectsOpen) return 'general';
  if (!isSettingsOpen(next)) return null;
  if (current === 'accounts' && next.accountsOpen) return 'accounts';
  if (isProjectPage(current) && next.projectsOpen) return current;
  return next.accountsOpen ? 'accounts' : 'general';
}

/** The flags that mean "on this page": exactly one is set. */
export function flagsForPage(page: SettingsPage): SettingsFlags {
  return page === 'accounts' ? { projectsOpen: false, accountsOpen: true } : { projectsOpen: true, accountsOpen: false };
}

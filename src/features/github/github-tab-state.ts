// github-page FR-3: the selected GitHub tab persists for the app RUN, not
// across restarts — plain module state rather than zustand/localStorage.
// GitHubView unmounts whenever the main pane leaves 'github' (MainPaneBody's
// dispatch table renders one branch at a time), so a `useState` default alone
// would reset to Pull requests every time; this module survives that unmount.

export type GithubTab = 'pulls' | 'commits' | 'branches';

let current: GithubTab = 'pulls';

export function getGithubTab(): GithubTab {
  return current;
}

export function setGithubTab(tab: GithubTab): void {
  current = tab;
}

// The Branches table's PULL REQUEST column (FR-10) jumps to a specific PR on
// the Pull requests tab. Carried the same way as `current` — plain module
// state, read once by PullsTab on mount and cleared — since GitHubView only
// mounts one body tab at a time (see the header comment above).
let pendingPullNumber: number | null = null;

/** Switches to the Pull requests tab and arms it to preselect `number`. */
export function selectPullInTab(number: number): void {
  current = 'pulls';
  pendingPullNumber = number;
}

/** One-shot read: returns the pending PR (if any) and clears it. */
export function consumePendingPull(): number | null {
  const p = pendingPullNumber;
  pendingPullNumber = null;
  return p;
}

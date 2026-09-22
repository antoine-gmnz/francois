// multi-account store slice: the app-wide account registry cache, kept current
// by App.tsx's `startAccountFeed` subscription (accounts.ts), plus the Accounts
// modal's own open flag and a one-shot "open straight into Add account" request
// so the command palette's two entries (FR-33 "Accounts" / "Add account") can
// reach a modal instance that does not exist yet. Split out like every other
// per-concern slice — see store.ts for the composition root.

import type { StateCreator } from 'zustand';
import type { Account } from '../../contract/multi-account';
import type { AppState } from './store';

export interface AccountsSlice {
  /** Hydrated by account_list at boot, kept current by account.list events (§6). */
  accounts: Account[];
  setAccounts: (accounts: Account[]) => void;
  accountsOpen: boolean;
  setAccountsOpen: (open: boolean) => void;
  /** Consumed once by AccountsModal's mount effect, then cleared — palette's "Add account". */
  accountsAutoAdd: boolean;
  setAccountsAutoAdd: (v: boolean) => void;
  /**
   * pi-models-metrics FR-1: one-shot request to open a Pi account's setup
   * takeover the moment the modal mounts — `RuntimeModelFieldStatus.onOpenSetup`'s
   * caller (the New Session form) closes itself and sets this before opening
   * the Accounts modal. Same idiom as `accountsAutoAdd`: consumed once, then
   * cleared, so re-opening the modal normally lands on the list.
   */
}

export const createAccountsSlice: StateCreator<AppState, [], [], AccountsSlice> = (set) => ({
  accounts: [],
  setAccounts: (accounts) => set({ accounts }),
  accountsOpen: false,
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
  accountsAutoAdd: false,
  setAccountsAutoAdd: (accountsAutoAdd) => set({ accountsAutoAdd }),
});

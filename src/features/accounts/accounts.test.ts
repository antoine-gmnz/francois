// multi-account (specs/multi-account.md) — frontend unit tests.
// Covers the zustand `accounts` + per-account `usageByAccount` slices (§6), the
// contract-typed invoke wrappers + the francois://account/event subscription
// helpers (§5), and every pure derivation the UI hangs off (FR-30..FR-36).
// No DOM framework is wired — the modal/chip/badge components are thin
// renderers over these.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError, SessionMeta } from '../../../contract/common';
import type { Account, AccountEvent, EndpointConfig } from '../../../contract/multi-account';
import { runtimeCapabilities } from '../../../contract/multi-provider-seam';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import type { UsageSnapshot } from '../../../contract/usage-bar';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import {
  accountAdd,
  accountAddCodex,
  accountAddEndpoint,
  accountAddGrok,
  accountCodexLogin,
  accountGrokLogin,
  accountList,
  accountLoginCancel,
  accountLoginResize,
  accountLoginWrite,
  accountRemove,
  accountRename,
  accountSetDefault,
  accountTestEndpoint,
  accountUpdateEndpoint,
  onAccountEvent,
} from '../../lib/api';
import { useStore } from '../../lib/store';
import {
  LOGIN_CANCEL_HINT,
  LOGIN_TITLE,
  accountBadgeText,
  accountIsEndpoint,
  accountSessionCounts,
  accountDisplayLabel,
  accountFieldOptions,
  accountIsCodex,
  accountIsGrok,
  accountUsageProbeable,
  codexAddPayload,
  codexLoginActionLabel,
  codexNeedsFirstLogin,
  codexSaveDisabled,
  grokAddPayload,
  grokLoginActionLabel,
  grokNeedsFirstLogin,
  grokSaveDisabled,
  accountMetersView,
  accountNeedsLogin,
  accountSecondaryEmail,
  clampCursor,
  defaultAccount,
  endpointAddPayload,
  endpointBaseUrlHasError,
  endpointErrorLine,
  endpointKeyPlaceholder,
  endpointProbeSuccessLine,
  endpointSaveDisabled,
  endpointTestPayload,
  endpointUpdatePayload,
  findAccount,
  formatModelIds,
  modelPickerProviderHeading,
  loginErrorMessage,
  middleTruncate,
  modelIdsForAdd,
  modelIdsForUpdate,
  moveCursor,
  accountIdForSessionCreate,
  newlyAddedAccountId,
  parseModelIdsList,
  removeConfirmView,
  resolveNewSessionAccountId,
  sessionAccountBadge,
  startAccountFeed,
  startLoginFeed,
  statusChipLabel,
  statusChipMaxChars,
  usageAccountId,
} from './accounts';

// ---------------------------------------------------------------- fixtures

const BUILT_IN: Account = {
  id: DEFAULT_ACCOUNT_ID,
  label: 'Default',
  email: 'me@work.example',
  configDir: null,
  builtIn: true,
  isDefault: true,
  createdAt: 0,
  kind: 'claude-code-oauth',
};

function account(over: Partial<Account> & { id: string }): Account {
  return {
    label: over.id,
    configDir: `/data/accounts/${over.id}`,
    builtIn: false,
    isDefault: false,
    createdAt: 1_000,
    kind: 'claude-code-oauth',
    ...over,
  };
}

function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    name: over.id,
    cwd: '/repo',
    model: { id: 'm', label: 'M' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: DEFAULT_ACCOUNT_ID,
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    ...over,
  };
}

const EMPTY_SNAPSHOT: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

/** Flush the microtask queue so promise chains inside the helpers settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  useStore.setState({ accounts: [], accountsOpen: false, accountsAutoAdd: false, usageByAccount: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------- store slices

describe('accounts store slice (§6)', () => {
  it('starts with an empty registry and a closed modal', () => {
    const s = useStore.getState();
    expect(s.accounts).toEqual([]);
    expect(s.accountsOpen).toBe(false);
    expect(s.accountsAutoAdd).toBe(false);
  });

  it('setAccounts replaces the whole list — the core is the only ordering authority (FR-7)', () => {
    const list = [BUILT_IN, account({ id: 'a1', label: 'perso' })];
    useStore.getState().setAccounts(list);
    expect(useStore.getState().accounts).toEqual(list);
    useStore.getState().setAccounts([BUILT_IN]);
    expect(useStore.getState().accounts).toEqual([BUILT_IN]);
  });

  it('setAccountsOpen / setAccountsAutoAdd are independent flags (palette FR-33)', () => {
    useStore.getState().setAccountsAutoAdd(true);
    useStore.getState().setAccountsOpen(true);
    expect(useStore.getState().accountsOpen).toBe(true);
    expect(useStore.getState().accountsAutoAdd).toBe(true);
    useStore.getState().setAccountsAutoAdd(false);
    expect(useStore.getState().accountsOpen).toBe(true);
  });
});

describe('usage store slice keyed by accountId (FR-27)', () => {
  const ready: UsageSnapshot = {
    status: 'ready',
    meters: [{ label: 'Current session', percentUsed: 42, resetsAt: 'Jul 22, 5:29pm' }],
    fetchedAt: 1_000,
    error: null,
  };

  it('stores one snapshot per account and leaves the others untouched', () => {
    useStore.getState().setAccountUsage(DEFAULT_ACCOUNT_ID, ready);
    useStore.getState().setAccountUsage('a1', EMPTY_SNAPSHOT);
    expect(useStore.getState().usageByAccount).toEqual({ [DEFAULT_ACCOUNT_ID]: ready, a1: EMPTY_SNAPSHOT });
  });

  it('an error for one account never touches another account (§7 last row)', () => {
    useStore.getState().setAccountUsage(DEFAULT_ACCOUNT_ID, ready);
    useStore.getState().setAccountUsage('a1', {
      status: 'error',
      meters: [],
      fetchedAt: null,
      error: { code: 'USAGE_UNAVAILABLE', message: 'nope' },
    });
    expect(useStore.getState().usageByAccount[DEFAULT_ACCOUNT_ID]).toEqual(ready);
    expect(useStore.getState().usageByAccount.a1.status).toBe('error');
  });
});

// -------------------------------------------------------------- api wrappers

describe('api wrappers (§5 physical binding)', () => {
  it('maps every verb onto account_<verb> and resolves the Result verbatim', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [] });
    await accountList();
    expect(invokeMock).toHaveBeenCalledWith('account_list', undefined);

    invokeMock.mockResolvedValue({ ok: true, data: { loginId: 'l1', cols: 80, rows: 24 } });
    await expect(accountAdd({ label: 'perso' })).resolves.toEqual({
      ok: true,
      data: { loginId: 'l1', cols: 80, rows: 24 },
    });
    expect(invokeMock).toHaveBeenCalledWith('account_add', { label: 'perso' });

    invokeMock.mockResolvedValue({ ok: true, data: null });
    await accountLoginWrite({ loginId: 'l1', data: 'y\r' });
    expect(invokeMock).toHaveBeenCalledWith('account_login_write', { loginId: 'l1', data: 'y\r' });
    await accountLoginResize({ loginId: 'l1', cols: 100, rows: 30 });
    expect(invokeMock).toHaveBeenCalledWith('account_login_resize', { loginId: 'l1', cols: 100, rows: 30 });
    await accountLoginCancel({ loginId: 'l1' });
    expect(invokeMock).toHaveBeenCalledWith('account_login_cancel', { loginId: 'l1' });
  });

  it('account_add with no argument sends an empty payload, never undefined (FR-11)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { loginId: 'l1', cols: 80, rows: 24 } });
    await accountAdd();
    expect(invokeMock).toHaveBeenCalledWith('account_add', {});
  });

  it('the three registry mutations carry accountId and resolve the fresh list', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [BUILT_IN] });
    await expect(accountRename('a1', 'perso')).resolves.toEqual({ ok: true, data: [BUILT_IN] });
    expect(invokeMock).toHaveBeenCalledWith('account_rename', { accountId: 'a1', label: 'perso' });
    await accountSetDefault('a1');
    expect(invokeMock).toHaveBeenCalledWith('account_set_default', { accountId: 'a1' });

    invokeMock.mockResolvedValue({ ok: true, data: { accounts: [BUILT_IN], reassignedSessions: ['s1'] } });
    await expect(accountRemove('a1')).resolves.toEqual({
      ok: true,
      data: { accounts: [BUILT_IN], reassignedSessions: ['s1'] },
    });
    expect(invokeMock).toHaveBeenCalledWith('account_remove', { accountId: 'a1' });
  });

  it('maps the three endpoint verbs onto account_<verb> (multi-provider-endpoint §5)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [BUILT_IN] });
    await accountAddEndpoint({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' });
    expect(invokeMock).toHaveBeenCalledWith('account_add_endpoint', {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-1',
    });

    await accountUpdateEndpoint({ accountId: 'e1', label: 'OpenAI', clearKey: true });
    expect(invokeMock).toHaveBeenCalledWith('account_update_endpoint', { accountId: 'e1', label: 'OpenAI', clearKey: true });

    invokeMock.mockResolvedValue({ ok: true, data: { models: [{ id: 'gpt-4o', label: 'gpt-4o' }], modelCount: 1 } });
    await expect(accountTestEndpoint({ baseUrl: 'https://api.openai.com/v1', accountId: 'e1' })).resolves.toEqual({
      ok: true,
      data: { models: [{ id: 'gpt-4o', label: 'gpt-4o' }], modelCount: 1 },
    });
    expect(invokeMock).toHaveBeenCalledWith('account_test_endpoint', { baseUrl: 'https://api.openai.com/v1', accountId: 'e1' });
  });

  it('surfaces an ok:false Result rather than throwing (ACCOUNT_NOT_REMOVABLE)', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'ACCOUNT_NOT_REMOVABLE', message: 'built-in' } });
    const res = await accountRemove(DEFAULT_ACCOUNT_ID);
    expect(res.ok).toBe(false);
  });

  it('onAccountEvent listens on francois://account/event and unwraps the payload', async () => {
    let handler: ((e: { payload: AccountEvent }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation((_n: string, cb: (e: { payload: AccountEvent }) => void) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    const seen: AccountEvent[] = [];
    const off = await onAccountEvent((e) => seen.push(e));
    expect(listenMock).toHaveBeenCalledWith('francois://account/event', expect.any(Function));
    handler?.({ payload: { type: 'account.list', accounts: [BUILT_IN] } });
    expect(seen).toEqual([{ type: 'account.list', accounts: [BUILT_IN] }]);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- the feed

describe('startAccountFeed (§6 hydration + FR-7 events)', () => {
  let handler: ((e: { payload: AccountEvent }) => void) | undefined;
  let unlisten: ReturnType<typeof vi.fn>;
  let listenResolve: ((u: () => void) => void) | undefined;

  beforeEach(() => {
    handler = undefined;
    listenResolve = undefined;
    unlisten = vi.fn();
    listenMock.mockImplementation((_n: string, cb: (e: { payload: AccountEvent }) => void) => {
      handler = cb;
      return new Promise<() => void>((resolve) => {
        listenResolve = resolve;
      });
    });
    invokeMock.mockResolvedValue({ ok: true, data: [BUILT_IN] });
  });

  const settleListen = () => listenResolve?.(unlisten);

  it('hydrates once with account_list and then follows account.list events', async () => {
    const applied: Account[][] = [];
    const stop = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();

    expect(invokeMock).toHaveBeenCalledWith('account_list', undefined);
    expect(applied).toEqual([[BUILT_IN]]);

    const grown = [BUILT_IN, account({ id: 'a1' })];
    handler?.({ payload: { type: 'account.list', accounts: grown } });
    expect(applied).toEqual([[BUILT_IN], grown]);
    stop();
  });

  it('drops a late hydration that would rewind a live list', async () => {
    let resolveList: ((r: unknown) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((r) => (resolveList = r)));
    const applied: Account[][] = [];
    const stop = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();

    const grown = [BUILT_IN, account({ id: 'a1' })];
    handler?.({ payload: { type: 'account.list', accounts: grown } });
    resolveList?.({ ok: true, data: [BUILT_IN] }); // stale read lands after the event
    await tick();

    expect(applied).toEqual([grown]);
    stop();
  });

  it('ignores the login sub-stream and any unknown member', async () => {
    const applied: Account[][] = [];
    const stop = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();
    applied.length = 0;

    handler?.({ payload: { type: 'account.login.data', loginId: 'l1', data: 'hi' } });
    handler?.({ payload: { type: 'whatever' } as unknown as AccountEvent });
    expect(applied).toEqual([]);
    stop();
  });

  it('tears down on stop, and unsubscribes even when stop precedes listen()', async () => {
    const applied: Account[][] = [];
    const stop = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();
    applied.length = 0;
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    handler?.({ payload: { type: 'account.list', accounts: [] } });
    expect(applied).toEqual([]);

    unlisten.mockClear();
    const stop2 = startAccountFeed((a) => applied.push(a));
    stop2();
    settleListen();
    await tick();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
  });

  it('survives an ok:false and a rejected hydration without throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'poisoned' } });
    const applied: Account[][] = [];
    const stop1 = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();
    expect(applied).toEqual([]);
    stop1();

    invokeMock.mockRejectedValue(new Error('ipc down'));
    const stop2 = startAccountFeed((a) => applied.push(a));
    settleListen();
    await tick();
    expect(applied).toEqual([]);
    stop2();
  });
});

describe('startLoginFeed (FR-12/FR-13/FR-15)', () => {
  let handler: ((e: { payload: AccountEvent }) => void) | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    handler = undefined;
    unlisten.mockClear();
    listenMock.mockImplementation((_n: string, cb: (e: { payload: AccountEvent }) => void) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
  });

  it('routes each login member to its own handler, carrying the loginId', async () => {
    const data: [string, string][] = [];
    const done: [string, Account][] = [];
    const failed: [string, AppError][] = [];
    const stop = startLoginFeed({
      onData: (id, d) => data.push([id, d]),
      onDone: (id, a) => done.push([id, a]),
      onFailed: (id, e) => failed.push([id, e]),
    });
    await tick();

    const a1 = account({ id: 'a1', email: 'p@x.example' });
    const err: AppError = { code: 'ACCOUNT_DUPLICATE', message: 'already registered' };
    handler?.({ payload: { type: 'account.login.data', loginId: 'l1', data: '\x1b[2J' } });
    handler?.({ payload: { type: 'account.login.done', loginId: 'l1', account: a1 } });
    handler?.({ payload: { type: 'account.login.failed', loginId: 'l2', error: err } });
    handler?.({ payload: { type: 'account.list', accounts: [] } }); // not a login member

    expect(data).toEqual([['l1', '\x1b[2J']]);
    expect(done).toEqual([['l1', a1]]);
    expect(failed).toEqual([['l2', err]]);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('applies nothing after stop', async () => {
    const data: string[] = [];
    const stop = startLoginFeed({ onData: (_id, d) => data.push(d) });
    await tick();
    stop();
    handler?.({ payload: { type: 'account.login.data', loginId: 'l1', data: 'x' } });
    expect(data).toEqual([]);
  });
});

// ------------------------------------------------------------- resolution

describe('registry resolution (FR-2/FR-4/FR-18/FR-20)', () => {
  const a1 = account({ id: 'a1', label: 'perso', email: 'p@x.example' });

  it('findAccount returns the row or null — never undefined', () => {
    expect(findAccount([BUILT_IN, a1], 'a1')).toEqual(a1);
    expect(findAccount([BUILT_IN, a1], 'nope')).toBeNull();
    expect(findAccount([], DEFAULT_ACCOUNT_ID)).toBeNull();
  });

  it('defaultAccount is the isDefault row', () => {
    const list = [{ ...BUILT_IN, isDefault: false }, { ...a1, isDefault: true }];
    expect(defaultAccount(list)?.id).toBe('a1');
  });

  it("falls back to the built-in 'default' row when no flag resolves (FR-4)", () => {
    expect(defaultAccount([{ ...BUILT_IN, isDefault: false }, a1])?.id).toBe(DEFAULT_ACCOUNT_ID);
    expect(defaultAccount([a1])?.id).toBe('a1'); // no built-in at all → the first row
    expect(defaultAccount([])).toBeNull();
  });

  it('resolveNewSessionAccountId honours a resolvable project default (FR-20)', () => {
    expect(resolveNewSessionAccountId([BUILT_IN, a1], 'a1')).toBe('a1');
  });

  it('a project default naming a removed account falls back to the isDefault one (FR-20)', () => {
    expect(resolveNewSessionAccountId([BUILT_IN, a1], 'gone')).toBe(DEFAULT_ACCOUNT_ID);
    expect(resolveNewSessionAccountId([BUILT_IN, a1], undefined)).toBe(DEFAULT_ACCOUNT_ID);
    expect(resolveNewSessionAccountId([{ ...BUILT_IN, isDefault: false }, { ...a1, isDefault: true }], undefined)).toBe('a1');
  });

  it("resolves to the reserved 'default' id when the registry has not hydrated yet", () => {
    expect(resolveNewSessionAccountId([], 'a1')).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('modelPickerProviderHeading (FR-21) is the SELECTED account\'s own label', () => {
    const endpoint = account({ id: 'e1', label: 'My Endpoint', kind: 'openai-compatible' });
    expect(modelPickerProviderHeading([BUILT_IN, a1, endpoint], 'a1')).toBe('perso');
    expect(modelPickerProviderHeading([BUILT_IN, a1, endpoint], 'e1')).toBe('My Endpoint');
    expect(modelPickerProviderHeading([BUILT_IN, a1, endpoint], BUILT_IN.id)).toBe('Default');
  });

  it('modelPickerProviderHeading is empty before the registry hydrates — never a fabricated label', () => {
    expect(modelPickerProviderHeading([], 'a1')).toBe('');
  });

  it('accountIdForSessionCreate always sends the selection verbatim (CRITICAL fix)', () => {
    // Explicitly picking the built-in Default account must be sent as-is, even
    // when a DIFFERENT account carries isDefault — omitting it here would have
    // bound the session to that other account instead of the one on screen.
    expect(accountIdForSessionCreate(DEFAULT_ACCOUNT_ID)).toBe(DEFAULT_ACCOUNT_ID);
    expect(accountIdForSessionCreate('a1')).toBe('a1');
  });

  it('accountFieldOptions lists every account with its email as secondary text (FR-31)', () => {
    expect(accountFieldOptions([BUILT_IN, a1])).toEqual([
      {
        value: DEFAULT_ACCOUNT_ID,
        label: 'Default',
        email: 'me@work.example',
        isDefault: true,
        needsLogin: false,
      },
      {
        value: 'a1',
        label: 'perso',
        email: 'p@x.example',
        isDefault: false,
        needsLogin: false,
      },
    ]);
  });

  it('flags an account needing re-login in the field options (FR-17/FR-22)', () => {
    const broken = account({ id: 'a2', label: 'old', authFailedAt: 9 });
    expect(accountFieldOptions([broken])[0].needsLogin).toBe(true);
  });
});

// ----------------------------------------------------------------- display

describe('display helpers (FR-32/FR-33, design brief)', () => {
  it('shows the label, and only the label when it IS the email', () => {
    const a = account({ id: 'a1', label: 'perso', email: 'p@x.example' });
    expect(accountDisplayLabel(a)).toBe('perso');
    expect(accountSecondaryEmail(a)).toBe('p@x.example');

    const emailLabelled = account({ id: 'a2', label: 'p@x.example', email: 'p@x.example' });
    expect(accountDisplayLabel(emailLabelled)).toBe('p@x.example');
    expect(accountSecondaryEmail(emailLabelled)).toBeNull();
  });

  it('labels an identity-less built-in row "Default" (FR-3)', () => {
    const bare: Account = { ...BUILT_IN, label: '', email: undefined };
    expect(accountDisplayLabel(bare)).toBe('Default');
    expect(accountSecondaryEmail(bare)).toBeNull();
  });

  it('accountNeedsLogin is driven by authFailedAt alone (FR-23)', () => {
    expect(accountNeedsLogin(BUILT_IN)).toBe(false);
    expect(accountNeedsLogin(account({ id: 'a1', authFailedAt: 0 }))).toBe(true);
    expect(accountNeedsLogin(account({ id: 'a1', authFailedAt: 1_700_000 }))).toBe(true);
  });

  it('badges a label with its first two letters, uppercased', () => {
    expect(accountBadgeText(account({ id: 'a1', label: 'perso', email: 'p@x.example' }))).toBe('PE');
    expect(accountBadgeText(account({ id: 'a1', label: 'Work Account' }))).toBe('WO');
  });

  it("badges an email-labelled account with its local part, capped at 6 (design brief)", () => {
    expect(accountBadgeText(account({ id: 'a1', label: 'antoine@x.example', email: 'antoine@x.example' }))).toBe('ANTOIN');
    expect(accountBadgeText(account({ id: 'a1', label: 'zoe@x.example', email: 'zoe@x.example' }))).toBe('ZOE');
  });

  it('gives no sidebar badge to a session on the default account — the badge means "unusual" (FR-32)', () => {
    const a1 = account({ id: 'a1', label: 'perso', email: 'p@x.example' });
    const accounts = [BUILT_IN, a1];
    expect(sessionAccountBadge(accounts, session({ id: 's1' }))).toBeNull();
    expect(sessionAccountBadge(accounts, session({ id: 's2', accountId: 'a1' }))).toEqual({
      text: 'PE',
      title: 'perso · p@x.example',
    });
  });

  it('gives no badge for an accountId that resolves to nothing (FR-10 prunes it to default)', () => {
    expect(sessionAccountBadge([BUILT_IN], session({ id: 's1', accountId: 'ghost' }))).toBeNull();
  });

  it('truncates the status-bar chip label with an ellipsis (design brief)', () => {
    expect(statusChipLabel('perso')).toBe('perso');
    expect(statusChipLabel('a-very-long-account-label')).toBe('a-very-long-accou…');
    expect(statusChipLabel('a-very-long-account-label', 8)).toBe('a-very-…');
  });

  it('caps the chip at 8 characters below ~900px window width, 18 above it (§Responsive)', () => {
    expect(statusChipMaxChars(899)).toBe(8);
    expect(statusChipMaxChars(900)).toBe(18);
    expect(statusChipMaxChars(1200)).toBe(18);
  });

  it('counts the sessions each account carries, defaulting the unresolvable ones (4a meta line)', () => {
    const accounts = [BUILT_IN, account({ id: 'a1' })];
    const counts = accountSessionCounts(accounts, [
      session({ id: 's1', accountId: 'a1' }),
      session({ id: 's2', accountId: 'a1' }),
      session({ id: 's3', accountId: DEFAULT_ACCOUNT_ID }),
      session({ id: 's4', accountId: 'ghost' }), // FR-10: resolves to the default
    ]);
    expect(counts).toEqual({ [DEFAULT_ACCOUNT_ID]: 2, a1: 2 });
  });
});

// ------------------------------------------------------------------ usage

describe('which account the bar and chip describe (FR-30)', () => {
  const a1 = account({ id: 'a1', label: 'perso' });
  const accounts = [BUILT_IN, a1];

  it("renders the SELECTED session's account", () => {
    const sessions = [session({ id: 's1', accountId: 'a1' }), session({ id: 's2' })];
    expect(usageAccountId(accounts, sessions, 's1')).toBe('a1');
    expect(usageAccountId(accounts, sessions, 's2')).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("falls back to the isDefault account with no session selected", () => {
    expect(usageAccountId(accounts, [], null)).toBe(DEFAULT_ACCOUNT_ID);
    const flipped = [{ ...BUILT_IN, isDefault: false }, { ...a1, isDefault: true }];
    expect(usageAccountId(flipped, [], null)).toBe('a1');
  });

  it("falls back for a session whose accountId no longer resolves, rather than showing nothing", () => {
    expect(usageAccountId(accounts, [session({ id: 's1', accountId: 'ghost' })], 's1')).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('accountMetersView maps each snapshot lifecycle onto what the row renders (FR-34)', () => {
    expect(accountMetersView(undefined).kind).toBe('none');
    expect(accountMetersView(EMPTY_SNAPSHOT).kind).toBe('none');
    expect(accountMetersView({ ...EMPTY_SNAPSHOT, status: 'loading' }).kind).toBe('loading');

    const ready: UsageSnapshot = {
      status: 'ready',
      meters: [{ label: 'Current session', percentUsed: 42, resetsAt: 'Jul 22, 5:29pm' }],
      fetchedAt: 1_000,
      error: null,
    };
    const view = accountMetersView(ready);
    expect(view.kind).toBe('meters');
    expect(view.chips.map((c) => c.percentText)).toEqual(['42%']);

    const failed = accountMetersView({
      status: 'error',
      meters: [],
      fetchedAt: null,
      error: { code: 'USAGE_UNAVAILABLE', message: 'Timed out fetching usage.' },
    });
    expect(failed.kind).toBe('error');
    expect(failed.message).toBe('Timed out fetching usage.');
  });

  it('keeps stale meters visible behind an error rather than blanking the row (FR-18 parity)', () => {
    const view = accountMetersView({
      status: 'error',
      meters: [{ label: 'Current session', percentUsed: 91, resetsAt: 'soon' }],
      fetchedAt: 5,
      error: { code: 'USAGE_UNAVAILABLE', message: 'nope' },
    });
    expect(view.kind).toBe('meters');
    expect(view.chips).toHaveLength(1);
    expect(view.message).toBe('nope');
  });
});

// ------------------------------------------------------------- modal copy

describe('modal copy (FR-35/FR-36, §7)', () => {
  const a1 = account({ id: 'a1', label: 'perso', email: 'p@x.example' });

  // FR-36's isolation note moved to providers.ts (`providerIsolationNote`) with
  // redesign 8b — one global "Claude Code configuration" sentence could not
  // stay true across three kinds of credential. Covered in providers.test.ts.

  it('names the account, its credentials and the sessions that fall back (FR-35)', () => {
    const sessions = [
      session({ id: 's1', name: 'api', accountId: 'a1' }),
      session({ id: 's2', name: 'web', accountId: 'a1' }),
      session({ id: 's3', name: 'other' }),
    ];
    const view = removeConfirmView(a1, sessions);
    expect(view.title).toBe('Remove perso?');
    expect(view.credentialsLine).toBe('Its credentials on this machine will be deleted.');
    expect(view.sessionsLine).toBe('2 sessions will fall back to Default:');
    expect(view.names).toEqual(['api', 'web']);
    expect(view.moreLabel).toBeNull();
  });

  it('says nothing about sessions when the account owns none', () => {
    const view = removeConfirmView(a1, [session({ id: 's3', name: 'other' })]);
    expect(view.sessionsLine).toBeNull();
    expect(view.names).toEqual([]);
  });

  it('singularizes one session and caps the list at five with a "+N more" (design brief)', () => {
    const one = removeConfirmView(a1, [session({ id: 's1', name: 'api', accountId: 'a1' })]);
    expect(one.sessionsLine).toBe('1 session will fall back to Default:');

    const many = removeConfirmView(
      a1,
      Array.from({ length: 7 }, (_, i) => session({ id: `s${i}`, name: `s${i}`, accountId: 'a1' })),
    );
    expect(many.names).toHaveLength(5);
    expect(many.moreLabel).toBe('+2 more');
  });

  it('turns each login failure code into the brief\'s copy (§7)', () => {
    expect(loginErrorMessage({ code: 'ACCOUNT_LOGIN_FAILED', message: 'x' })).toBe('Login timed out');
    expect(loginErrorMessage({ code: 'ACCOUNT_DUPLICATE', message: 'x' })).toBe(
      'This Anthropic account is already registered — the credential store may be shared on ' +
        'this platform, so it cannot be isolated here.',
    );
    expect(loginErrorMessage({ code: 'PTY_ERROR', message: 'x' })).toBe('Could not start claude');
    expect(loginErrorMessage({ code: 'SPAWN_FAILED', message: 'x' })).toBe('Could not start claude');
  });

  it('falls back to the core message for anything it does not recognize', () => {
    expect(loginErrorMessage({ code: 'INVALID_INPUT', message: 'a login is already running' })).toBe(
      'a login is already running',
    );
    expect(loginErrorMessage({ code: 'INTERNAL', message: '' })).toBe('Login failed');
  });

  it('states the login hints the terminal cannot show itself (§Notes)', () => {
    expect(LOGIN_TITLE).toBe('LOGGING IN — complete the Claude Code sign-in below');
    expect(LOGIN_CANCEL_HINT).toBe('Esc to cancel');
  });
});

// -------------------------------------------------------------- keyboard

describe('list keyboard (§3 Keyboard)', () => {
  it('moves the cursor within bounds and never wraps', () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, 1, 3)).toBe(2);
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, -1, 3)).toBe(1);
  });

  it('collapses to 0 on an empty list', () => {
    expect(moveCursor(0, 1, 0)).toBe(0);
    expect(clampCursor(4, 0)).toBe(0);
  });

  it('clamps a cursor left past the end by a removal', () => {
    expect(clampCursor(4, 3)).toBe(2);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(1, 3)).toBe(1);
  });
});

// ------------------------------------------------------ endpoint accounts

// multi-provider-seam FR-12/FR-16: `kind` is a CARRIED discriminator. The core
// sets it (an older registry's rows default to 'claude-code-oauth') and the
// frontend never derives it — nothing here reads the capability table. So the
// only way it breaks on this surface is a feed or a resolution helper rebuilding
// an Account field-by-field instead of handing the core's own object on.
describe('Account.kind is carried, never re-derived (multi-provider-seam FR-12)', () => {
  const endpointish = account({ id: 'e1', label: 'OpenAI', kind: 'openai-compatible' });

  it('the account.list feed applies the list verbatim, both kinds intact', async () => {
    let handler: ((e: { payload: AccountEvent }) => void) | undefined;
    let resolveListen: ((u: () => void) => void) | undefined;
    listenMock.mockImplementation((_n: string, cb: (e: { payload: AccountEvent }) => void) => {
      handler = cb;
      return new Promise<() => void>((r) => {
        resolveListen = r;
      });
    });
    invokeMock.mockResolvedValue({ ok: true, data: [BUILT_IN] });

    const applied: Account[][] = [];
    const stop = startAccountFeed((a) => applied.push(a));
    resolveListen?.(() => {});
    await tick();
    handler?.({ payload: { type: 'account.list', accounts: [BUILT_IN, endpointish] } });

    expect(applied).toEqual([[BUILT_IN], [BUILT_IN, endpointish]]);
    expect(applied[0][0].kind).toBe('claude-code-oauth');
    expect(applied[1][1].kind).toBe('openai-compatible');
    stop();
  });

  it('the store and the resolution helpers hand back the SAME object, so no field can be dropped', () => {
    const list = [BUILT_IN, endpointish];
    expect(findAccount(list, 'e1')).toBe(endpointish);
    expect(defaultAccount(list)).toBe(BUILT_IN);
    useStore.getState().setAccounts(list);
    expect(useStore.getState().accounts[1]).toBe(endpointish);
  });
});

describe('endpoint accounts (multi-provider-endpoint FR-13..FR-16)', () => {
  const ENDPOINT: EndpointConfig = { baseUrl: 'https://api.openai.com/v1', hasKey: true, modelIds: ['gpt-4o'] };
  const endpointAccount = account({ id: 'e1', label: 'OpenAI', kind: 'openai-compatible', endpoint: ENDPOINT });

  it('accountIsEndpoint is true only for openai-compatible accounts', () => {
    expect(accountIsEndpoint(endpointAccount)).toBe(true);
    expect(accountIsEndpoint(BUILT_IN)).toBe(false);
  });

  // multi-provider-openai FR-22: multi-provider-endpoint FR-14's disabled
  // block is deleted — an openai-compatible option is now as plain as an
  // oauth one, with no reason line and no `disabled` flag anywhere.
  it('keeps an openai-compatible field option fully selectable, same shape as an oauth one (FR-22)', () => {
    const opts = accountFieldOptions([BUILT_IN, endpointAccount]);
    expect(opts[0]).toEqual({
      value: DEFAULT_ACCOUNT_ID,
      label: 'Default',
      email: 'me@work.example',
      isDefault: true,
      needsLogin: false,
    });
    expect(opts[1]).toEqual({
      value: 'e1',
      label: 'OpenAI',
      email: null,
      isDefault: false,
      needsLogin: false,
    });
  });

  it('middle-truncates a long base URL, keeping both ends readable', () => {
    const short = 'https://api.openai.com/v1';
    expect(middleTruncate(short, 40)).toBe(short);
    const long = 'https://a-very-long-hostname.example.com/some/very/deep/path/v1';
    const truncated = middleTruncate(long, 30);
    expect(truncated.length).toBe(30);
    expect(truncated).toContain('…');
    expect(truncated.startsWith('https://a')).toBe(true);
    expect(long.endsWith(truncated.slice(truncated.indexOf('…') + 1))).toBe(true);
  });

  it('placeholders the key field per FR-15', () => {
    expect(endpointKeyPlaceholder(true)).toBe('•••••••• stored');
    expect(endpointKeyPlaceholder(false)).toBe('sk-…');
  });

  it('parses a comma-separated model list, trimming and dropping blanks', () => {
    expect(parseModelIdsList('gpt-4o, gpt-4o-mini ,  ,')).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(parseModelIdsList('')).toEqual([]);
    expect(parseModelIdsList('   ')).toEqual([]);
  });

  it('omits modelIds on add when the field is empty — discover from /models (FR-6)', () => {
    expect(modelIdsForAdd('gpt-4o, gpt-4o-mini')).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(modelIdsForAdd('')).toBeUndefined();
    expect(modelIdsForAdd('  ,  ')).toBeUndefined();
  });

  it('clears the override (null) on update rather than leaving it unchanged (FR-7)', () => {
    expect(modelIdsForUpdate('gpt-4o')).toEqual(['gpt-4o']);
    expect(modelIdsForUpdate('')).toBeNull();
    expect(modelIdsForUpdate('  ,  ')).toBeNull();
  });

  it('formats a stored model list back into the comma-separated field', () => {
    expect(formatModelIds(['gpt-4o', 'gpt-4o-mini'])).toBe('gpt-4o, gpt-4o-mini');
    expect(formatModelIds(undefined)).toBe('');
  });

  it('disables Save until Label and Base URL are both non-empty, or while busy', () => {
    expect(endpointSaveDisabled('', '', false)).toBe(true);
    expect(endpointSaveDisabled('OpenAI', '', false)).toBe(true);
    expect(endpointSaveDisabled('', 'https://x', false)).toBe(true);
    expect(endpointSaveDisabled('OpenAI', 'https://x', false)).toBe(false);
    expect(endpointSaveDisabled('OpenAI', 'https://x', true)).toBe(true);
  });

  it('highlights Base URL on an INVALID_INPUT from either Save or Test (design brief §2 Validation error, round-2 MEDIUM)', () => {
    const invalidInput: AppError = { code: 'INVALID_INPUT', message: 'base URL must be https' };
    const unreachable: AppError = { code: 'ACCOUNT_ENDPOINT_UNREACHABLE', message: 'timed out' };
    // Save path (already covered pre-fix).
    expect(endpointBaseUrlHasError(invalidInput, null)).toBe(true);
    // Test path — the gap this fix closes: a probe's own INVALID_INPUT must
    // highlight the field exactly like a save-triggered one does.
    expect(endpointBaseUrlHasError(null, invalidInput)).toBe(true);
    // Neither error, or a non-INVALID_INPUT error on either path — no border.
    expect(endpointBaseUrlHasError(null, null)).toBe(false);
    expect(endpointBaseUrlHasError(null, unreachable)).toBe(false);
    expect(endpointBaseUrlHasError(unreachable, null)).toBe(false);
  });

  it('reads the probe success line — zero models is success, not an error (design brief §2)', () => {
    expect(endpointProbeSuccessLine({ models: [], modelCount: 12 })).toBe('reachable · 12 models');
    expect(endpointProbeSuccessLine({ models: [], modelCount: 0 })).toBe('reachable · 0 models');
    expect(endpointProbeSuccessLine({ models: [], modelCount: 1 })).toBe('reachable · 1 model');
  });

  it("maps each failure code to the brief's one-sentence copy (§2 Test failed)", () => {
    expect(endpointErrorLine({ code: 'ACCOUNT_ENDPOINT_UNAUTHORIZED', message: 'nope' })).toBe(
      "the endpoint rejected that key",
    );
    expect(endpointErrorLine({ code: 'ACCOUNT_ENDPOINT_UNREACHABLE', message: 'connect ECONNREFUSED' })).toBe(
      "couldn't reach that URL",
    );
    // core message shape (src-tauri/src/account/endpoint.rs::probe): the only
    // case that legitimately carries a status is "the endpoint returned HTTP {code}".
    expect(
      endpointErrorLine({ code: 'ACCOUNT_ENDPOINT_UNREACHABLE', message: 'the endpoint returned HTTP 500' }),
    ).toBe('endpoint answered 500');
    expect(
      endpointErrorLine({ code: 'INVALID_INPUT', message: 'base URL must be https (http is allowed on localhost only)' }),
    ).toBe('base URL must be https (http is allowed on localhost only)');
  });

  it('never misreports a transport error as a status when it merely embeds a bare 3-digit token (frontend quality fix)', () => {
    // e.g. a connect-refused message naming a port, not an HTTP status.
    expect(
      endpointErrorLine({
        code: 'ACCOUNT_ENDPOINT_UNREACHABLE',
        message: 'could not reach the endpoint: tcp connect error: 127.0.0.1:8080 connection refused',
      }),
    ).toBe("couldn't reach that URL");
    // a DNS/timeout message with a bare 3-digit number elsewhere in the text.
    expect(
      endpointErrorLine({
        code: 'ACCOUNT_ENDPOINT_UNREACHABLE',
        message: 'could not reach the endpoint: operation timed out after 10000ms (attempt 302)',
      }),
    ).toBe("couldn't reach that URL");
  });

  it('builds the Test payload, using the stored key on an untouched edit form (FR-9)', () => {
    expect(endpointTestPayload('https://x/v1', 'sk-live', 'e1')).toEqual({ baseUrl: 'https://x/v1', apiKey: 'sk-live' });
    expect(endpointTestPayload('https://x/v1', '', 'e1')).toEqual({ baseUrl: 'https://x/v1', accountId: 'e1' });
    expect(endpointTestPayload('https://x/v1', '', undefined)).toEqual({ baseUrl: 'https://x/v1' });
  });

  it('builds the add payload — apiKey/modelIds absent when their fields are empty', () => {
    expect(endpointAddPayload(' OpenAI ', ' https://x/v1 ', '', '')).toEqual({
      label: 'OpenAI',
      baseUrl: 'https://x/v1',
      apiKey: undefined,
      modelIds: undefined,
    });
    expect(endpointAddPayload('OpenAI', 'https://x/v1', 'sk-1', 'gpt-4o, gpt-4o-mini')).toEqual({
      label: 'OpenAI',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-1',
      modelIds: ['gpt-4o', 'gpt-4o-mini'],
    });
  });

  it('builds the update payload — clearKey and apiKey never both present (FR-7)', () => {
    expect(endpointUpdatePayload('e1', 'OpenAI', 'https://x/v1', '', false, '')).toEqual({
      accountId: 'e1',
      label: 'OpenAI',
      baseUrl: 'https://x/v1',
      apiKey: undefined,
      clearKey: undefined,
      modelIds: null,
    });
    expect(endpointUpdatePayload('e1', 'OpenAI', 'https://x/v1', 'sk-new', false, 'gpt-4o')).toEqual({
      accountId: 'e1',
      label: 'OpenAI',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-new',
      clearKey: undefined,
      modelIds: ['gpt-4o'],
    });
    expect(endpointUpdatePayload('e1', 'OpenAI', 'https://x/v1', '', true, '')).toEqual({
      accountId: 'e1',
      label: 'OpenAI',
      baseUrl: 'https://x/v1',
      apiKey: undefined,
      clearKey: true,
      modelIds: null,
    });
  });

  it('names the newly added account by diffing the list the core returned (fresh-flash parity with login)', () => {
    expect(newlyAddedAccountId([BUILT_IN], [BUILT_IN, endpointAccount])).toBe('e1');
    expect(newlyAddedAccountId([BUILT_IN, endpointAccount], [BUILT_IN, endpointAccount])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// multi-provider-codex — the 'codex-cli' account kind (FR-21a/FR-24/FR-25).

describe('codex accounts', () => {
  const codex = (over: Partial<Account> = {}) =>
    account({ id: 'cx', kind: 'codex-cli', signedIn: false, ...over });

  it('recognises a codex account and does not confuse it with an endpoint one', () => {
    expect(accountIsCodex(codex())).toBe(true);
    expect(accountIsEndpoint(codex())).toBe(false);
    expect(accountIsCodex(account({ id: 'a' }))).toBe(false);
    expect(accountIsCodex(account({ id: 'e', kind: 'openai-compatible' }))).toBe(false);
  });

  // FR-21a: the whole reason `signedIn` exists — `authFailedAt` cannot answer
  // this, because it is only ever set BY a failed turn.
  it('says Sign in before there is any credential and Re-login after', () => {
    expect(codexLoginActionLabel(codex({ signedIn: false }))).toBe('Sign in');
    expect(codexLoginActionLabel(codex({ signedIn: true }))).toBe('Re-login');
  });

  it('never claims a non-codex row needs a first sign-in', () => {
    // A Claude row has no `signedIn` at all; asking must not read `undefined`
    // as "not signed in" and offer a Codex login on the wrong runtime.
    expect(codexNeedsFirstLogin(account({ id: 'a' }))).toBe(false);
    expect(codexNeedsFirstLogin(account({ id: 'e', kind: 'openai-compatible' }))).toBe(false);
    expect(codexNeedsFirstLogin(codex({ signedIn: true }))).toBe(false);
    expect(codexNeedsFirstLogin(codex({ signedIn: false }))).toBe(true);
  });

  // FR-24: a Codex account is a label and nothing else.
  it('disables Save until the label has real content', () => {
    expect(codexSaveDisabled('', false)).toBe(true);
    expect(codexSaveDisabled('   ', false)).toBe(true);
    expect(codexSaveDisabled('Work', true)).toBe(true); // busy
    expect(codexSaveDisabled('Work', false)).toBe(false);
  });

  it('trims the label into the add payload', () => {
    expect(codexAddPayload('  Work ChatGPT  ')).toEqual({ label: 'Work ChatGPT' });
  });

  it('sends account_add_codex and account_codex_login on the right channels', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: [] });
    await accountAddCodex({ label: 'Work' });
    expect(invokeMock).toHaveBeenCalledWith('account_add_codex', { label: 'Work' });

    invokeMock.mockResolvedValueOnce({ ok: true, data: undefined });
    await accountCodexLogin({ accountId: 'cx' });
    expect(invokeMock).toHaveBeenCalledWith('account_codex_login', { accountId: 'cx' });
  });

  // FR-21: no account kind is disabled in the picker — the endpoint block
  // multi-provider-openai FR-22 deleted stayed deleted, and Codex never had one.
  it('is selectable in the account picker', () => {
    const options = accountFieldOptions([account({ id: 'a' }), codex()]);
    expect(options.map((o) => o.value)).toEqual(['a', 'cx']);
    expect(options).toHaveLength(2);
  });

  // The bug this guards: a freshly added Codex account came back carrying a full
  // Claude profile (.claude.json, projects/, sessions/) because the usage seed
  // spawned `claude` with that account's dir as CLAUDE_CONFIG_DIR — and `claude`
  // initializes whatever dir it is pointed at. The filter used to be
  // `!accountIsEndpoint(a)`, which admitted every kind that was not an endpoint.
  it('never probes plan limits for an account whose runtime has no plan', () => {
    expect(accountUsageProbeable(account({ id: 'a' }))).toBe(true);
    expect(accountUsageProbeable(codex())).toBe(false);
    expect(accountUsageProbeable(account({ id: 'e', kind: 'openai-compatible' }))).toBe(false);
  });

  it('derives probeability from the capability table, not from a list of kinds', () => {
    // The guarantee that matters for the NEXT runtime: whatever the table says
    // about usageBar is what the seed does, with nothing to remember to update.
    for (const kind of ['claude-code-oauth', 'openai-compatible', 'codex-cli', 'grok-cli'] as const) {
      const runtime = {
        'claude-code-oauth': 'claude-code',
        'openai-compatible': 'francois',
        'codex-cli': 'codex',
        'grok-cli': 'grok',
      } as const;
      expect(accountUsageProbeable(account({ id: 'x', kind }))).toBe(
        runtimeCapabilities(runtime[kind]).usageBar.available,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// multi-provider-grok — the 'grok-cli' account kind (FR-2/FR-20/FR-21/FR-22).
// Structurally the same shape as the codex accounts block above — mirrored on
// purpose, per the spec's "structurally this is multi-provider-codex again".

describe('grok accounts', () => {
  const grok = (over: Partial<Account> = {}) =>
    account({ id: 'gk', kind: 'grok-cli', signedIn: false, ...over });

  it('recognises a grok account and does not confuse it with codex or an endpoint one', () => {
    expect(accountIsGrok(grok())).toBe(true);
    expect(accountIsEndpoint(grok())).toBe(false);
    expect(accountIsCodex(grok())).toBe(false);
    expect(accountIsGrok(account({ id: 'a' }))).toBe(false);
    expect(accountIsGrok(account({ id: 'e', kind: 'openai-compatible' }))).toBe(false);
    expect(accountIsGrok(account({ id: 'cx', kind: 'codex-cli' }))).toBe(false);
  });

  it('says Sign in before there is any credential and Re-login after', () => {
    expect(grokLoginActionLabel(grok({ signedIn: false }))).toBe('Sign in');
    expect(grokLoginActionLabel(grok({ signedIn: true }))).toBe('Re-login');
  });

  it('never claims a non-grok row needs a first sign-in', () => {
    expect(grokNeedsFirstLogin(account({ id: 'a' }))).toBe(false);
    expect(grokNeedsFirstLogin(account({ id: 'e', kind: 'openai-compatible' }))).toBe(false);
    expect(grokNeedsFirstLogin(account({ id: 'cx', kind: 'codex-cli', signedIn: false }))).toBe(false);
    expect(grokNeedsFirstLogin(grok({ signedIn: true }))).toBe(false);
    expect(grokNeedsFirstLogin(grok({ signedIn: false }))).toBe(true);
  });

  it('disables Save until the label has real content', () => {
    expect(grokSaveDisabled('', false)).toBe(true);
    expect(grokSaveDisabled('   ', false)).toBe(true);
    expect(grokSaveDisabled('Work', true)).toBe(true); // busy
    expect(grokSaveDisabled('Work', false)).toBe(false);
  });

  it('trims the label into the add payload', () => {
    expect(grokAddPayload('  SuperGrok  ')).toEqual({ label: 'SuperGrok' });
  });

  it('sends account_add_grok and account_grok_login on the right channels', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: [] });
    await accountAddGrok({ label: 'SuperGrok' });
    expect(invokeMock).toHaveBeenCalledWith('account_add_grok', { label: 'SuperGrok' });

    invokeMock.mockResolvedValueOnce({ ok: true, data: undefined });
    await accountGrokLogin({ accountId: 'gk' });
    expect(invokeMock).toHaveBeenCalledWith('account_grok_login', { accountId: 'gk' });
  });

  it('is selectable in the account picker', () => {
    const options = accountFieldOptions([account({ id: 'a' }), grok()]);
    expect(options.map((o) => o.value)).toEqual(['a', 'gk']);
    expect(options).toHaveLength(2);
  });

  // Same regression guard as the codex block: a fresh grok-cli account must
  // never be usage-probed with `claude`, which would plant a Claude profile
  // inside its GROK_HOME.
  it('never probes plan limits for an account whose runtime has no plan', () => {
    expect(accountUsageProbeable(grok())).toBe(false);
  });
});

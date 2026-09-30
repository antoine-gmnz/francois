import { expect, it } from 'vitest';
import type { Account } from '../../../contract/multi-account';
import { cloudAccountId, cloudAccounts } from './cloud-sessions';

const account = (id: string, kind: Account['kind'], isDefault = false): Account => ({ id, kind, isDefault, label: id, builtIn: false, configDir: null, createdAt: 0 });

it('uses an eligible explicit Claude account when the app default is Codex', () => {
  const accounts = [account('codex', 'codex-cli', true), account('claude-1', 'claude-code-oauth'), account('claude-2', 'claude-code-oauth')];
  expect(cloudAccounts(accounts).map(a => a.id)).toEqual(['claude-1', 'claude-2']);
  expect(cloudAccountId(accounts, null)).toBe('claude-1');
  expect(cloudAccountId(accounts, 'claude-2')).toBe('claude-2');
  expect(cloudAccountId(accounts, 'codex')).toBe('claude-1');
  expect(cloudAccountId([accounts[0]], null)).toBeNull();
});

it('prefers the eligible default and recovers from a removed selection', () => {
  const accounts = [account('first', 'claude-code-oauth'), account('default', 'claude-code-oauth', true)];
  expect(cloudAccountId(accounts, null)).toBe('default');
  expect(cloudAccountId(accounts, 'removed')).toBe('default');
  expect(cloudAccountId([], 'default')).toBeNull();
});

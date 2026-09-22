import { createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionMeta } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { AccountField } from './AccountField';
import { ProfileField } from './ProfileField';
import { SessionContextMenu } from './SessionContextMenu';
import { modelSelectionMismatch } from './new-session-form';

vi.mock('../../lib/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/store')>();
  return { ...original, useStore: Object.assign((selector: (s: ReturnType<typeof original.useStore.getState>) => unknown) => selector(original.useStore.getState()), original.useStore) };
});

const claude = { id: 'default', kind: 'claude-code-oauth', label: 'Claude', configDir: null, builtIn: true, isDefault: true, createdAt: 0 } as Account;
beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} }));

it('keeps missing retired account/profile selections visible without choosing another option', () => {
  const change = vi.fn();
  const account = renderToStaticMarkup(createElement(AccountField, { accounts: [claude], accountId: 'missing-pi', fromProject: true, onChange: change }));
  expect(account).toMatch(/<option[^>]*value="missing-pi"[^>]*disabled=""[^>]*selected=""/);
  expect(account).toContain('missing-pi · Unavailable');
  const profile = renderToStaticMarkup(createElement(ProfileField, { profiles: [], profileId: 'missing-profile', onChange: change }));
  expect(profile).toContain('missing-profile · Unavailable');
  expect(change).not.toHaveBeenCalled();
});

it('requires an explicit account choice when only a saved Pi model remains', () => {
  const model = { providerId: 'saved', modelId: 'saved' };
  const markup = renderToStaticMarkup(createElement(AccountField, { accounts: [claude], accountId: 'default', unavailableDefault: true, fromProject: true, onChange: vi.fn() }));
  expect(markup).toContain('Saved Pi default · Unavailable');
  expect(markup).toMatch(/<option[^>]*value="__retired-default__"[^>]*disabled=""[^>]*selected=""/);
  expect(modelSelectionMismatch(claude, 'sonnet', model)).not.toBeNull();
  expect(modelSelectionMismatch(claude, 'sonnet', undefined)).toBeNull();
});

it('does not expose removal or worktree confirmation for read-only history', () => {
  const action = vi.fn();
  const markup = renderToStaticMarkup(createElement(SessionContextMenu, { readOnly: true, menu: {sessionId: 'pi', x: 0, y: 0, confirming: true, error: null, editors: []}, sessionName: 'Saved Pi', sessionPath: '/repo', worktree: null, containerRef: {current:null}, onStartConfirm:action, onOpenSettings:action, onCopyPath:action, onCancel:action, onToggleRemoveWorktree:action, onRemove:action, onOpenInEditor:action }));
  expect(markup).not.toContain('Remove session');
  expect(markup).not.toContain('Also remove the worktree');
  expect(markup).toContain('Copy path');
  expect(action).not.toHaveBeenCalled();
});

it('renders pending historic permission and question actions disabled', async () => {
  const { useStore } = await import('../../lib/store');
  useStore.getState().setSessions([{ id: 'pi', agentRuntime: 'pi', status: 'idle', effectiveCapabilities: { permissions: {available:true} } } as SessionMeta]);
  const PermissionCard = (await import('../permissions/PermissionCard')).default;
  const QuestionCard = (await import('../questions/QuestionCard')).default;
  const permission = renderToStaticMarkup(createElement(PermissionCard, { sessionId: 'pi', b: {kind:'permission', blockId:'p', isStreaming:false, state:'pending', ask:{toolName:'Bash',summary:'npm test',inputJson:'{}',cwd:'/repo',pattern:'Bash(npm test:*)',patternLabel:'npm test'}} }));
  const question = renderToStaticMarkup(createElement(QuestionCard, { sessionId: 'pi', b: {kind:'question',blockId:'q',isStreaming:false,state:'pending',questions:[{header:'Choice',question:'Pick one',multiSelect:false,options:[{label:'Yes (Recommended)',description:'yes'}]}]} }));
  for (const markup of [permission, question]) {
    const actions = markup.match(/<(?:button|input)[^>]*>/g) ?? [];
    expect(actions.length).toBeGreaterThan(0);
    // Disclosure buttons may still expose historical details; execution options cannot.
    const execution = actions.filter(a => /pcard__(choice|tier)|qcard__(accept|option|other)/.test(a));
    expect(execution.length).toBeGreaterThan(0);
    for (const action of execution) expect(action).toContain('disabled=""');
  }
});

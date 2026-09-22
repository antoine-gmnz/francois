import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { runtimeCapabilities } from '../../../contract/multi-provider-seam';
import { observeRequestEvent } from '../../lib/request-replies';
import { useStore } from '../../lib/store';
import QuestionCard from './QuestionCard';
import PermissionCard from '../permissions/PermissionCard';
vi.mock('../../lib/store', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/store')>();
  return { ...original, useStore: Object.assign((selector: (s: ReturnType<typeof original.useStore.getState>) => unknown) => selector(original.useStore.getState()), original.useStore) };
});
const meta = { id: 'native-ui', agentRuntime: 'codex', status: 'running', runtimeGeneration: 'live', effectiveCapabilities: { ...runtimeCapabilities('codex'), permissions: { available: true } } } as SessionMeta;
beforeEach(() => useStore.setState({ sessions: [meta] }));
it('shows offered Cancel turn without unavailable Deny/Always controls', () => {
  const ask = { toolName: 'Bash', summary: 'echo', inputJson: '{}', cwd: '/repo', pattern: '', patternLabel: '', allowedDecisions: ['allowOnce', 'cancel'] as const };
  observeRequestEvent({ type: 'permission.asked', sessionId: meta.id, blockId: 'p', ask: { ...ask, allowedDecisions: [...ask.allowedDecisions] } }, meta);
  const html = renderToStaticMarkup(createElement(PermissionCard, { sessionId: meta.id, b: { kind: 'permission', blockId: 'p', isStreaming: true, state: 'pending', ask: { ...ask, allowedDecisions: [...ask.allowedDecisions] } } }));
  expect(html).toContain('Cancel turn');
  expect(html).not.toContain('deny once');
  expect(html).not.toContain('always applies to');
});
it('masks native freeform secrets and redacts raw legacy saved answers defensively', () => {
  const questions = [{ id: 'token', header: 'Token', question: 'Secret?', multiSelect: false, options: [], isSecret: true, isOther: false }];
  observeRequestEvent({ type: 'question.asked', sessionId: meta.id, blockId: 'q', questions }, meta);
  const block = { kind: 'question' as const, blockId: 'q', isStreaming: true, state: 'pending' as const, questions };
  const html = renderToStaticMarkup(createElement(QuestionCard, { sessionId: meta.id, b: block }));
  expect(html).toContain('type="password"');
  expect(html).toContain('aria-label="Token"');
  const resolved = renderToStaticMarkup(createElement(QuestionCard, { sessionId: meta.id, b: { ...block, state: 'answered', answers: { token: 'SENTINEL' } } }));
  expect(resolved).toContain('[redacted]');
  expect(resolved).not.toContain('SENTINEL');
});
it('does not invent Other for native enumerated questions', () => {
  const questions = [{ id: 'pick', header: 'Pick', question: 'Pick', multiSelect: false, options: [{ label: 'Yes', description: '' }], isOther: false }];
  observeRequestEvent({ type: 'question.asked', sessionId: meta.id, blockId: 'options', questions }, meta);
  const html = renderToStaticMarkup(createElement(QuestionCard, { sessionId: meta.id, b: { kind: 'question', blockId: 'options', isStreaming: true, state: 'pending', questions } }));
  expect(html).not.toContain('Something else');
});

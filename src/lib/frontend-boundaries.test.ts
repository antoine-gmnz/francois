// process-frontend-boundaries — source-level ratchets for the frontend slice.
//
// FR-1: the shared tab/request helpers and the stores that consume them import
// no `src/features/**` module. FR-4: the shared-to-feature edges this slice did
// NOT remove are pinned as an exact list, so a new one fails here and a removed
// one forces the list to shrink. Key goal: React/zustand code branches on
// capability flags, never on a runtime or account-kind name, outside the
// designated mapping modules.

import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FEATURE_IMPORT = /from\s+'(?:\.\.\/)+features\/[^']+'|from\s+'\.\.\/features\/[^']+'/g;

function featureImports(path: string): string[] {
  return (sources[path] ?? '').match(FEATURE_IMPORT) ?? [];
}

describe('shared helpers stay independent of feature folders (FR-1)', () => {
  const SHARED = [
    '/src/lib/agent-tab.ts',
    '/src/lib/agentTabStore.ts',
    '/src/lib/sessionsStore.ts',
    '/src/lib/question-answers.ts',
    '/src/lib/request-replies.ts',
    '/src/lib/runtimeCapability.ts',
    '/src/lib/session-events.ts',
  ];

  it.each(SHARED)('%s exists and imports no src/features module', (path) => {
    expect(sources[path], path).toBeTypeOf('string');
    expect(featureImports(path)).toEqual([]);
  });

  it('leaves no consumer of the old features/agents/agent-tab path', () => {
    const stale = Object.entries(sources)
      .filter(([, text]) => /features\/agents\/agent-tab'|from '\.\/agent-tab'/.test(text))
      .map(([path]) => path)
      .filter((path) => !path.startsWith('/src/lib/'));
    expect(stale).toEqual([]);
  });
});

describe('remaining shared-to-feature edges are pinned, not claimed eliminated (FR-4)', () => {
  it('matches the recorded follow-up list exactly', () => {
    const edges = Object.keys(sources)
      .filter((path) => path.startsWith('/src/lib/'))
      .flatMap((path) => featureImports(path).map((edge) => `${path} ${edge.replace(/^from\s+/, '')}`))
      .sort();
    expect(edges).toEqual([
      "/src/lib/extensionsStore.ts '../features/extensions/ext-bar'",
      "/src/lib/extensionsStore.ts '../features/extensions/extensions'",
      "/src/lib/layoutStore.ts '../features/shell/shell'",
      "/src/lib/overviewStore.ts '../features/overview/overview'",
      "/src/lib/projectsStore.ts '../features/projects/projects'",
      "/src/lib/remoteStore.ts '../features/remote/remote-control'",
    ]);
  });
});

describe('no runtime-name branching outside the mapping modules', () => {
  // The modules that legitimately translate a runtime/account-kind name into
  // behaviour. Everything else asks them (sessionCapability, sessionIsRetired,
  // accountIsRetired, profileIsRetired, requestNeedsLiveGeneration).
  const MAPPING_MODULES = new Set([
    '/src/lib/runtimeCapability.ts',
    '/src/features/accounts/accounts.ts',
    '/src/features/accounts/providers.ts',
  ]);
  const RUNTIME_NAME = "'(?:claude-code|codex|grok|francois|pi|claude-code-oauth|openai-compatible|codex-cli|grok-cli)'";
  const BRANCH = new RegExp(
    `(?:agentRuntime|\\.kind|\\bkind)\\s*[!=]==\\s*${RUNTIME_NAME}|${RUNTIME_NAME}\\s*[!=]==\\s*[\\w.?]*(?:agentRuntime|kind)\\b`,
  );

  it('keeps every agentRuntime/kind literal comparison inside a mapping module', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !MAPPING_MODULES.has(path) && !path.startsWith('/src/demo/'))
      .flatMap(([path, text]) =>
        text.split('\n').flatMap((line, i) => (BRANCH.test(line) ? [`${path}:${i + 1}`] : [])),
      );
    expect(offenders).toEqual([]);
  });
});

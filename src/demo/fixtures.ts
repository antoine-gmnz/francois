// Demo fixtures — the fake fleet Francois shows when VITE_FRANCOIS_DEMO=1.
//
// This exists for ONE reason: the README screenshot and GIF. A real capture
// would leak whatever repo happened to be open, cost a live turn, and never
// reproduce the same frame twice. Everything below is invented — the repos, the
// paths, the transcript, the accounts. Nothing here is imported by the app in a
// normal build (src/demo/demo.ts is the only entry point, and it is tree-shaken
// out when the flag is off), so it is safe for it to be as fictional as it likes.

import type {
  AgentInfo,
  AgentStep,
  McpServerInfo,
  ModelInfo,
  SessionMeta,
  SkillInfo,
  SlashCommandInfo,
  WorkflowRun,
} from '../../contract/common';
import type { ConversationBlock } from '../../contract/conversation-view';
import type { DiffSummary, FileDiff } from '../../contract/diff-view';
import type { Account } from '../../contract/multi-account';
import type { ProjectMeta } from '../../contract/projects';
import type { UsageSnapshot } from '../../contract/usage-bar';

/**
 * Frozen clock for the whole fixture set, so every relative age is stable.
 *
 * Both of these are written to stay SHAKEABLE: the `#__PURE__` annotation tells
 * Rollup the `Date.now()` call has no side effect, and ages are plain arithmetic
 * rather than a `minutes(n)` helper — a top-level call would be treated as a
 * side effect and anchor this whole module in a shipped bundle.
 */
export const T0 = /*#__PURE__*/ Date.now();
const MIN = 60_000;

// ---------- models ----------

const OPUS_ID = 'claude-opus-5';
const SONNET_ID = 'claude-sonnet-5';
const HAIKU_ID = 'claude-haiku-4-5-20251001';

export const OPUS: ModelInfo = {
  id: OPUS_ID,
  label: 'Opus 5',
  brief: '1M context · 64K output · extended thinking',
  contextTokens: 1_000_000,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};
export const SONNET: ModelInfo = {
  id: SONNET_ID,
  label: 'Sonnet 5',
  brief: '1M context · 64K output',
  contextTokens: 1_000_000,
  efforts: ['low', 'medium', 'high'],
};
export const HAIKU: ModelInfo = {
  id: HAIKU_ID,
  label: 'Haiku 4.5',
  brief: '200K context · 8K output · fastest',
  contextTokens: 200_000,
  efforts: [],
};

export const MODELS: ModelInfo[] = [OPUS, SONNET, HAIKU];

// ---------- accounts ----------

export const ACCOUNTS: Account[] = [
  {
    id: 'default',
    label: 'Personal',
    email: 'you@example.com',
    organization: 'Personal',
    configDir: null,
    builtIn: true,
    isDefault: true,
    createdAt: 0,
    kind: 'claude-code-oauth',
  },
  {
    id: 'acct-work',
    label: 'Work',
    email: 'you@orbitlabs.dev',
    organization: 'Orbit Labs',
    configDir: '~/.francois/accounts/work',
    builtIn: false,
    isDefault: false,
    createdAt: T0 - (60 * 24 * 40) * MIN,
    kind: 'claude-code-oauth',
  },
  // multi-provider-endpoint FR-13: a demo row so the kind chip and base-URL
  // line are visible in the demo fleet — fully selectable per FR-22.
  {
    id: 'acct-openai',
    label: 'OpenAI',
    configDir: '~/.francois/accounts/acct-openai',
    builtIn: false,
    isDefault: false,
    createdAt: T0 - (60 * 24 * 10) * MIN,
    kind: 'openai-compatible',
    endpoint: { baseUrl: 'https://api.openai.com/v1', hasKey: true },
  },
];

// ---------- projects ----------

export const PROJECT_ORBIT = 'proj-orbit';
export const PROJECT_LEDGER = 'proj-ledger';
export const PROJECT_INFRA = 'proj-infra';

export const PROJECTS: ProjectMeta[] = [
  {
    id: PROJECT_ORBIT,
    name: 'orbit',
    root: '~/code/orbit',
    defaults: { modelId: OPUS_ID, permissionMode: 'acceptEdits', runtime: 'native', accountId: 'acct-work' },
    createdAt: T0 - (60 * 24 * 90) * MIN,
    lastUsedAt: T0 - (4) * MIN,
    rootExists: true,
  },
  {
    id: PROJECT_LEDGER,
    name: 'ledger',
    root: '~/code/ledger',
    defaults: { modelId: SONNET_ID, permissionMode: 'default', runtime: 'native' },
    createdAt: T0 - (60 * 24 * 210) * MIN,
    lastUsedAt: T0 - (38) * MIN,
    rootExists: true,
  },
  {
    id: PROJECT_INFRA,
    name: 'infra',
    root: '~/code/infra',
    defaults: { modelId: HAIKU_ID, permissionMode: 'plan', runtime: 'native' },
    createdAt: T0 - (60 * 24 * 320) * MIN,
    lastUsedAt: T0 - (126) * MIN,
    rootExists: true,
  },
];

// ---------- sessions ----------

export const S_API = 'sess-orbit-api';
export const S_WEB = 'sess-orbit-web';
export const S_WORKER = 'sess-orbit-worker';
export const S_LEDGER = 'sess-ledger';
export const S_INFRA = 'sess-infra';
export const S_DOCS = 'sess-docs';

// Spread into each session below rather than applied by a helper function:
// a top-level CALL is a possible side effect, so Rollup would keep it — and
// keeping it anchors this whole module in a shipped bundle. Object spread in a
// literal has no such problem. See the note in demo.ts.
const BASE: Omit<SessionMeta, 'id' | 'name' | 'cwd'> = {
  model: OPUS,
  status: 'idle',
  contextUsedTokens: 0,
  contextLimitTokens: 1_000_000,
  startedAt: T0 - (20) * MIN,
  lastActivityAt: T0 - (1) * MIN,
  permissionMode: 'acceptEdits',
  runtime: 'native',
  accountId: 'acct-work',
  agentRuntime: 'claude-code',
  protocol: 'anthropic',
};

export const SESSIONS: SessionMeta[] = [
  {
    ...BASE,
    id: S_API,
    name: 'orbit-api',
    cwd: '~/code/orbit/services/api',
    projectId: PROJECT_ORBIT,
    status: 'running',
    contextUsedTokens: 128_400,
    startedAt: T0 - (12) * MIN,
    lastActivityAt: T0,
  },
  {
    ...BASE,
    id: S_WEB,
    name: 'orbit-web',
    cwd: '~/code/orbit/apps/web',
    projectId: PROJECT_ORBIT,
    model: SONNET,
    status: 'running',
    contextUsedTokens: 412_900,
    startedAt: T0 - (34) * MIN,
    lastActivityAt: T0 - (1) * MIN,
  },
  {
    ...BASE,
    id: S_WORKER,
    name: 'billing-retry',
    cwd: '~/code/orbit/services/worker',
    projectId: PROJECT_ORBIT,
    status: 'idle',
    contextUsedTokens: 74_200,
    startedAt: T0 - (58) * MIN,
    lastActivityAt: T0 - (6) * MIN,
    worktree: {
      branch: 'feat/billing-retry',
      baseRef: 'origin/main',
      path: '~/code/orbit-worktrees/billing-retry',
      sourceRepoRoot: '~/code/orbit',
      createdBranch: true,
      fetched: true,
    },
  },
  {
    ...BASE,
    id: S_LEDGER,
    name: 'ledger',
    cwd: '~/code/ledger',
    projectId: PROJECT_LEDGER,
    model: SONNET,
    status: 'idle',
    contextUsedTokens: 88_600,
    contextLimitTokens: 1_000_000,
    startedAt: T0 - (96) * MIN,
    lastActivityAt: T0 - (38) * MIN,
    accountId: 'default',
  },
  {
    ...BASE,
    id: S_INFRA,
    name: 'infra',
    cwd: '~/code/infra',
    projectId: PROJECT_INFRA,
    model: HAIKU,
    status: 'done',
    contextUsedTokens: 41_300,
    contextLimitTokens: 200_000,
    startedAt: T0 - (180) * MIN,
    lastActivityAt: T0 - (126) * MIN,
    permissionMode: 'plan',
    accountId: 'default',
  },
  {
    ...BASE,
    id: S_DOCS,
    name: 'docs-site',
    cwd: '~/code/orbit/apps/docs',
    projectId: PROJECT_ORBIT,
    model: HAIKU,
    status: 'error',
    contextUsedTokens: 9_800,
    contextLimitTokens: 200_000,
    startedAt: T0 - (240) * MIN,
    lastActivityAt: T0 - (232) * MIN,
    errorMessage: 'npm run build exited 1 — see transcript',
  },
];

/** The session the demo opens on and animates. */
export const ACTIVE_SESSION = S_API;

// ---------- transcript (the hero session) ----------

const b = (n: number) => `blk-${n}`;

/**
 * design 9a: the turn header states when a prompt was sent and how long the
 * reply ran, both derived from the blocks' own `at`. The demo fleet stamps
 * them relative to T0 so the hero session shows a real clock and a real
 * duration instead of a header with both halves missing.
 */
const at = (secondsAgo: number) => T0 - secondsAgo * 1000;

export const TRANSCRIPT: ConversationBlock[] = [
  {
    kind: 'user',
    blockId: b(1),
    at: at(452),
    isStreaming: false,
    queued: false,
    text: 'The OAuth callback drops the `state` param when the token exchange is retried, so every retry fails CSRF validation. Track it down and fix it — with a regression test.',
  },
  {
    kind: 'assistant',
    blockId: b(2),
    at: at(447),
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: "Let me read the callback handler and the retry wrapper it goes through — the state is almost certainly being rebuilt rather than carried.",
  },
  {
    kind: 'tool',
    blockId: b(3),
    at: at(431),
    isStreaming: false,
    tool: 'Read',
    glyph: '⧉',
    glyphColor: '#8b93a3',
    bodyColor: '#8b93a3',
    summary: 'src/auth/callback.ts',
    meta: '214 lines',
  },
  {
    kind: 'tool',
    blockId: b(4),
    at: at(402),
    isStreaming: false,
    tool: 'Grep',
    glyph: '⌕',
    glyphColor: '#8b93a3',
    bodyColor: '#8b93a3',
    summary: 'state|nonce  ·  src/auth',
    meta: '18 matches in 6 files',
  },
  {
    kind: 'assistant',
    blockId: b(5),
    at: at(355),
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: 'Found it. `withRetry()` in src/auth/retry.ts rebuilds the request from `req.query` — but the caller already consumed `state` off it, so the second attempt sends an empty one. The fix is to capture the exchange params once, before the first attempt, and replay that captured object.',
  },
  {
    kind: 'tool',
    blockId: b(6),
    at: at(296),
    isStreaming: false,
    tool: 'Edit',
    glyph: '✎',
    glyphColor: '#8fbab8',
    bodyColor: '#8b93a3',
    summary: 'src/auth/retry.ts',
    meta: '+34 −19',
  },
  {
    kind: 'subagent',
    blockId: b(7),
    at: at(240),
    isStreaming: false,
    glyph: '⇉',
    glyphColor: '#b39ede',
    bodyColor: '#c3c9d4',
    agentName: 'test-writer',
    agentModel: 'Sonnet 5',
    meta: 'regression test for the retried callback',
  },
  {
    kind: 'tool',
    blockId: b(8),
    at: at(174),
    isStreaming: false,
    tool: 'Bash',
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#8b93a3',
    summary: 'npm test -- auth',
    meta: '31 passed, 0 failed · 4.2s',
  },
  {
    kind: 'assistant',
    blockId: b(9),
    at: at(108),
    isStreaming: false,
    glyph: '●',
    glyphColor: '#8b93a3',
    bodyColor: '#c3c9d4',
    text: 'All 31 auth tests pass, including the new one, which fails against the old `withRetry` exactly as it should. The change is contained to the retry wrapper — the callback handler itself is untouched, so nothing else in the OAuth path shifts.',
  },
];

// ---------- agents ----------

export const AGENTS: AgentInfo[] = [
  {
    id: 'agent-test-writer',
    sessionId: S_API,
    name: 'test-writer',
    task: 'regression test for the retried OAuth callback',
    status: 'running',
    startedAt: T0 - (2) * MIN - 14_000,
    background: true,
    lastActivity: 'Write  src/auth/retry.test.ts',
    stepCount: 12,
  },
  {
    id: 'agent-reviewer',
    sessionId: S_API,
    name: 'reviewer',
    task: 'audit the token exchange for other consumed-once params',
    status: 'running',
    startedAt: T0 - (1) * MIN - 41_000,
    background: true,
    lastActivity: 'Grep  req.query  ·  src',
    stepCount: 7,
  },
  {
    id: 'agent-explorer',
    sessionId: S_API,
    name: 'explorer',
    task: 'map every caller of withRetry',
    status: 'done',
    startedAt: T0 - (6) * MIN,
    endedAt: T0 - (4) * MIN - 22_000,
    background: false,
    lastActivity: '9 call sites across 4 services',
    stepCount: 18,
  },
];

export const AGENT_STEPS: Record<string, AgentStep[]> = {
  'agent-test-writer': [
    { seq: 1, kind: 'notice', at: T0 - (2) * MIN - 14_000, label: 'dispatched · Sonnet 5' },
    { seq: 2, kind: 'tool', at: T0 - (2) * MIN, tool: 'Read', label: 'src/auth/retry.ts', meta: '188 lines' },
    { seq: 3, kind: 'tool', at: T0 - (1) * MIN - 30_000, tool: 'Read', label: 'src/auth/callback.test.ts', meta: '96 lines' },
    { seq: 4, kind: 'text', at: T0 - (1) * MIN, label: 'The existing suite never exercises a second attempt.' },
    { seq: 5, kind: 'tool', at: T0 - 34_000, tool: 'Write', label: 'src/auth/retry.test.ts', meta: '+58 −0' },
  ],
  'agent-reviewer': [
    { seq: 1, kind: 'notice', at: T0 - (1) * MIN - 41_000, label: 'dispatched · Opus 5' },
    { seq: 2, kind: 'tool', at: T0 - (1) * MIN, tool: 'Grep', label: 'req.query  ·  src', meta: '23 matches in 9 files' },
    { seq: 3, kind: 'tool', at: T0 - 28_000, tool: 'Read', label: 'src/auth/token.ts', meta: '141 lines' },
  ],
  'agent-explorer': [
    { seq: 1, kind: 'notice', at: T0 - (6) * MIN, label: 'dispatched · Haiku 4.5' },
    { seq: 2, kind: 'tool', at: T0 - (5) * MIN, tool: 'Grep', label: 'withRetry(', meta: '9 matches in 4 files' },
    { seq: 3, kind: 'notice', at: T0 - (4) * MIN - 22_000, label: 'completed · 9 call sites across 4 services' },
  ],
};

// ---------- mcp ----------

export const MCP: McpServerInfo[] = [
  { name: 'cartograph', status: 'connected', toolCount: 9, scope: 'user' },
  { name: 'serena', status: 'connected', toolCount: 24, scope: 'user' },
  { name: 'postgres', status: 'connected', toolCount: 6, scope: 'project' },
  { name: 'sentry', status: 'connecting', scope: 'project' },
  { name: 'puppeteer', status: 'error', errorMessage: 'handshake timeout', scope: 'local' },
];

// ---------- skills ----------

export const SKILLS: SkillInfo[] = [
  { name: 'brainstorm', description: 'multi-persona panel that challenges a feature idea', installed: true, scope: 'user', kind: 'skill' },
  { name: 'build', description: 'author the contract, then one implementer per surface', installed: true, scope: 'user', kind: 'skill' },
  { name: 'review', description: 'audit the feature against its frozen spec', installed: true, scope: 'user', kind: 'skill' },
  { name: 'ship', description: 'commit, push and open the PR at a SHIP verdict', installed: true, scope: 'user', kind: 'skill' },
  { name: 'migrate', description: 'generate and apply a schema migration', installed: true, scope: 'project', kind: 'command' },
  { name: 'security-review', description: 'security review of the pending changes', installed: true, scope: 'plugin', kind: 'skill', pluginId: 'security@anthropic' },
  { name: 'pdf', description: 'read & parse PDFs', installed: false, scope: 'plugin', kind: 'skill', pluginId: 'docs@anthropic' },
  { name: 'dataviz', description: 'charts that read as one system', installed: false, scope: 'plugin', kind: 'skill', pluginId: 'viz@anthropic' },
];

export const COMMANDS: SlashCommandInfo[] = [
  { name: 'model', description: 'switch the model for this session', source: 'builtin' },
  { name: 'compact', description: 'compact the context window', source: 'builtin' },
  { name: 'clear', description: 'wipe the transcript and reset context', source: 'builtin' },
  { name: 'usage', description: 'plan limits and reset clock', source: 'builtin' },
  { name: 'context', description: 'what is filling the context window', source: 'builtin' },
  ...SKILLS.filter((s) => s.installed).map((s) => ({
    name: s.name,
    description: s.description,
    source: 'skill' as const,
    scope: s.scope as 'project' | 'user' | 'plugin',
  })),
];

// ---------- workflows ----------

export const WORKFLOWS: WorkflowRun[] = [
  {
    id: 'wf-1',
    sessionId: S_API,
    name: 'review-auth-surface',
    description: 'Review the auth surface across dimensions, verify each finding',
    status: 'running',
    startedAt: T0 - (3) * MIN - 8_000,
    phases: [
      { title: 'Review', detail: 'one agent per dimension' },
      { title: 'Verify', detail: 'adversarially refute each finding' },
      { title: 'Synthesize' },
    ],
    runId: 'wf_9c2b1a7f',
    lastActivity: 'Verify · 4 findings in flight',
    transcriptDir: '~/.francois/workflows/wf_9c2b1a7f',
  },
  {
    id: 'wf-2',
    sessionId: S_API,
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',
    status: 'done',
    startedAt: T0 - (22) * MIN,
    endedAt: T0 - (17) * MIN,
    phases: [{ title: 'Scan' }, { title: 'Fix' }],
    runId: 'wf_41d0e6b3',
    lastActivity: 'completed · 2 flaky tests, both fixed',
  },
];

// ---------- diff ----------

export const DIFF: Record<string, DiffSummary> = {
  [S_API]: {
    files: [
      { path: 'src/auth/callback.ts', dir: 'src/auth', name: 'callback.ts', additions: 12, deletions: 8, status: 'modified' },
      { path: 'src/auth/retry.ts', dir: 'src/auth', name: 'retry.ts', additions: 34, deletions: 19, status: 'modified' },
      { path: 'src/auth/retry.test.ts', dir: 'src/auth', name: 'retry.test.ts', additions: 58, deletions: 0, status: 'added' },
      { path: 'src/auth/token.ts', dir: 'src/auth', name: 'token.ts', additions: 6, deletions: 6, status: 'modified' },
      { path: 'src/http/middleware.ts', dir: 'src/http', name: 'middleware.ts', additions: 3, deletions: 1, status: 'modified' },
      { path: 'src/legacy/state-cache.ts', dir: 'src/legacy', name: 'state-cache.ts', additions: 0, deletions: 47, status: 'deleted' },
      { path: 'CHANGELOG.md', dir: '', name: 'CHANGELOG.md', additions: 4, deletions: 0, status: 'modified' },
    ],
    totalAdd: 117,
    totalDel: 81,
  },
  [S_WEB]: {
    files: [
      { path: 'src/routes/login.tsx', dir: 'src/routes', name: 'login.tsx', additions: 21, deletions: 4, status: 'modified' },
      { path: 'src/routes/login.css', dir: 'src/routes', name: 'login.css', additions: 9, deletions: 2, status: 'modified' },
      { path: 'src/lib/session.ts', dir: 'src/lib', name: 'session.ts', additions: 14, deletions: 14, status: 'modified' },
    ],
    totalAdd: 44,
    totalDel: 20,
  },
  [S_WORKER]: {
    files: [
      { path: 'src/billing/retry.ts', dir: 'src/billing', name: 'retry.ts', additions: 27, deletions: 5, status: 'modified' },
      { path: 'src/billing/queue.ts', dir: 'src/billing', name: 'queue.ts', additions: 8, deletions: 3, status: 'modified' },
    ],
    totalAdd: 35,
    totalDel: 8,
  },
};

const FILE_DIFF_RETRY: FileDiff = {
  binary: false,
  hunks: [
    {
      header: '@@ -18,14 +18,20 @@ export async function withRetry<T>(',
      lines: [
        { kind: 'ctx', oldNo: 18, newNo: 18, text: '  req: ExchangeRequest,' },
        { kind: 'ctx', oldNo: 19, newNo: 19, text: '  opts: RetryOptions = {},' },
        { kind: 'ctx', oldNo: 20, newNo: 20, text: '): Promise<T> {' },
        { kind: 'add', newNo: 21, text: '  // Capture the exchange params ONCE, before the first attempt. `req.query`' },
        { kind: 'add', newNo: 22, text: '  // is consumed by the caller, so rebuilding from it on attempt 2 sends an' },
        { kind: 'add', newNo: 23, text: '  // empty `state` and every retry fails CSRF validation.' },
        { kind: 'add', newNo: 24, text: '  const params = Object.freeze({ ...req.query });' },
        { kind: 'add', newNo: 25, text: '' },
        { kind: 'ctx', oldNo: 21, newNo: 26, text: '  let lastError: unknown;' },
        { kind: 'ctx', oldNo: 22, newNo: 27, text: '  for (let attempt = 0; attempt <= opts.max ?? 3; attempt++) {' },
        { kind: 'del', oldNo: 23, text: '    const params = { ...req.query };' },
        { kind: 'del', oldNo: 24, text: '    if (!params.state) params.state = mintState();' },
        { kind: 'add', newNo: 28, text: '    if (!params.state) throw new MissingStateError(req.id);' },
        { kind: 'ctx', oldNo: 25, newNo: 29, text: '    try {' },
        { kind: 'ctx', oldNo: 26, newNo: 30, text: '      return await exchange(params);' },
        { kind: 'ctx', oldNo: 27, newNo: 31, text: '    } catch (err) {' },
        { kind: 'ctx', oldNo: 28, newNo: 32, text: '      lastError = err;' },
        { kind: 'ctx', oldNo: 29, newNo: 33, text: '      if (!isRetryable(err)) throw err;' },
        { kind: 'add', newNo: 34, text: '      await backoff(attempt, opts);' },
        { kind: 'ctx', oldNo: 30, newNo: 35, text: '    }' },
        { kind: 'ctx', oldNo: 31, newNo: 36, text: '  }' },
        { kind: 'ctx', oldNo: 32, newNo: 37, text: '  throw lastError;' },
      ],
    },
  ],
};

const FILE_DIFF_GENERIC: FileDiff = {
  binary: false,
  hunks: [
    {
      header: '@@ -1,8 +1,9 @@',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: "import type { Request, Response } from 'express';" },
        { kind: 'ctx', oldNo: 2, newNo: 2, text: "import { exchange } from './token';" },
        { kind: 'add', newNo: 3, text: "import { withRetry } from './retry';" },
        { kind: 'ctx', oldNo: 3, newNo: 4, text: '' },
        { kind: 'ctx', oldNo: 4, newNo: 5, text: 'export async function callback(req: Request, res: Response) {' },
        { kind: 'del', oldNo: 5, text: '  const state = req.query.state;' },
        { kind: 'add', newNo: 6, text: '  const { state, code } = req.query;' },
        { kind: 'ctx', oldNo: 6, newNo: 7, text: '  if (!state) return res.status(400).end();' },
      ],
    },
    {
      header: '@@ -34,11 +35,12 @@ export async function callback(',
      lines: [
        { kind: 'ctx', oldNo: 34, newNo: 35, text: '  try {' },
        { kind: 'del', oldNo: 35, text: '    const token = await exchange({ code, state });' },
        { kind: 'add', newNo: 36, text: '    // withRetry now owns the params, so the state survives attempt 2+.' },
        { kind: 'add', newNo: 37, text: '    const token = await withRetry(req, { max: 3 });' },
        { kind: 'ctx', oldNo: 36, newNo: 38, text: '    return res.json(token);' },
        { kind: 'ctx', oldNo: 37, newNo: 39, text: '  } catch (err) {' },
        { kind: 'del', oldNo: 38, text: '    logger.warn({ err }, "token exchange failed");' },
        { kind: 'add', newNo: 40, text: '    logger.warn({ err, requestId: req.id }, "token exchange failed");' },
        { kind: 'ctx', oldNo: 39, newNo: 41, text: '    return res.status(502).end();' },
        { kind: 'ctx', oldNo: 40, newNo: 42, text: '  }' },
      ],
    },
  ],
};

export function fileDiff(path: string): FileDiff {
  return path.endsWith('retry.ts') ? FILE_DIFF_RETRY : FILE_DIFF_GENERIC;
}

// ---------- usage ----------

export const USAGE: Record<string, UsageSnapshot> = {
  default: {
    status: 'ready',
    fetchedAt: T0 - (3) * MIN,
    error: null,
    meters: [
      { label: 'Current session', percentUsed: 34, resetsAt: 'in 2h 41m' },
      { label: 'Current week (all models)', percentUsed: 61, resetsAt: 'Aug 6, 9:00am' },
    ],
  },
  'acct-work': {
    status: 'ready',
    fetchedAt: T0 - (1) * MIN,
    error: null,
    meters: [
      { label: 'Current session', percentUsed: 47, resetsAt: 'in 1h 12m' },
      { label: 'Current week (all models)', percentUsed: 72, resetsAt: 'Aug 6, 9:00am' },
      { label: 'Current week (Opus)', percentUsed: 88, resetsAt: 'Aug 6, 9:00am' },
    ],
  },
};

// ---------- shell ----------

export const SHELL_BANNER = [
  '\x1b[38;5;108m~/code/orbit/services/api\x1b[0m \x1b[38;5;246mon\x1b[0m \x1b[38;5;179mfeat/oauth-state-retry\x1b[0m',
  '❯ git status --short',
  ' \x1b[33mM\x1b[0m src/auth/callback.ts',
  ' \x1b[33mM\x1b[0m src/auth/retry.ts',
  ' \x1b[32mA\x1b[0m src/auth/retry.test.ts',
  ' \x1b[33mM\x1b[0m src/auth/token.ts',
  ' \x1b[33mM\x1b[0m src/http/middleware.ts',
  ' \x1b[31mD\x1b[0m src/legacy/state-cache.ts',
  ' \x1b[33mM\x1b[0m CHANGELOG.md',
  '',
  '\x1b[38;5;108m~/code/orbit/services/api\x1b[0m \x1b[38;5;246mon\x1b[0m \x1b[38;5;179mfeat/oauth-state-retry\x1b[0m',
  '❯ npm test -- auth',
  '',
  ' \x1b[32m✓\x1b[0m src/auth/retry.test.ts \x1b[38;5;246m(9 tests) 412ms\x1b[0m',
  ' \x1b[32m✓\x1b[0m src/auth/callback.test.ts \x1b[38;5;246m(14 tests) 288ms\x1b[0m',
  ' \x1b[32m✓\x1b[0m src/auth/token.test.ts \x1b[38;5;246m(8 tests) 173ms\x1b[0m',
  '',
  ' \x1b[38;5;246mTest Files\x1b[0m  \x1b[32m3 passed\x1b[0m \x1b[38;5;246m(3)\x1b[0m',
  ' \x1b[38;5;246m     Tests\x1b[0m  \x1b[32m31 passed\x1b[0m \x1b[38;5;246m(31)\x1b[0m',
  ' \x1b[38;5;246m  Duration\x1b[0m  4.21s',
  '',
  '\x1b[38;5;108m~/code/orbit/services/api\x1b[0m \x1b[38;5;246mon\x1b[0m \x1b[38;5;179mfeat/oauth-state-retry\x1b[0m',
  '❯ ',
].join('\r\n');

// Demo backend — a fake core, for capturing the README screenshot and GIF.
//
// Every frontend↔core call funnels through `ipc()` and the `listen()` wrappers in
// src/lib/api.ts (plus the shell's two call sites). When VITE_FRANCOIS_DEMO=1
// those route here instead of Tauri, so the app renders a whole invented fleet
// with no `claude` process, no repo, and no account. The flag is a compile-time
// constant, so a normal `npm run build` tree-shakes this module out entirely.
//
// The timeline at the bottom keeps the app MOVING — streaming assistant text,
// agent steps, a rising context meter — so a recording started at any moment
// catches something happening, and loops rather than settling into a still.

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AgentInfo, AgentStep, Result, SessionEvent, SessionMeta } from '../../contract/common';
import type { AgentBlock, AgentEvent } from '../../contract/agent-tab';
import type { ConversationBlock } from '../../contract/conversation-view';
import type { ShellEvent, ShellInfo, ShellOwner } from '../../contract/shell-terminal';
import { COLLAPSED_GROUPS_KEY } from '../features/sessions/roster-groups';
import {
  ACCOUNTS,
  AGENTS,
  AGENT_STEPS,
  COMMANDS,
  DIFF,
  MCP,
  MODELS,
  PROJECTS,
  PROJECT_ORBIT,
  SESSIONS,
  SHELL_BANNER,
  SKILLS,
  S_API,
  T0,
  TRANSCRIPT,
  USAGE,
  WORKFLOWS,
  fileDiff,
} from './fixtures';

// Every guard here and at the call sites tests the `__FRANCOIS_DEMO__` literal
// DIRECTLY, never an exported `DEMO` const. Vite's `define` substitutes the
// literal per module, but Rollup does not propagate a constant across module
// boundaries — importing the flag would leave `if (DEMO)` unfoldable in api.ts
// and drag this whole fake fleet into the shipped bundle. Same reasoning drives
// the "no top-level calls" notes below. Guarded by scripts/capture/no-demo.test.mjs.

/** Version the demo build reports, so captures don't advertise a dev build. */
export const DEMO_VERSION = '0.17.8';

const ok = <T>(data: T): Result<T> => ({ ok: true, data });

// ---------- deterministic opening view ----------
//
// Layout and project scope persist in localStorage, so without this a capture
// inherits whatever the last run left behind — a collapsed roster group
// silently amputates the shot. Driven through the store rather than by writing
// the keys before it is created, because that would need a module-scope side
// effect here, and Rollup keeps those: it would anchor this module (and the
// whole fake fleet) in a shipped bundle. The store is imported DYNAMICALLY for
// the same reason, and to avoid a static cycle (store → features → api → here).
async function openingView() {
  const { useStore } = await import('../lib/store');
  const s = useStore.getState();
  // Scope the board to one project so the app lands on that project's SESSION
  // tab rather than the cross-project OVERVIEW dashboard.
  s.setActiveProjectId(PROJECT_ORBIT);
  s.setMainTab('session');
  if (s.theme !== 'dark') s.setTheme('dark');
  if (!s.showLeftPane) s.toggleLeftPane();
  // design 7a: no right column and no per-card collapse left to reset — but the
  // roster's repo groups are collapsible and persisted, so they are what a stale
  // localStorage can now amputate.
  try {
    localStorage.removeItem(COLLAPSED_GROUPS_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- event bus ----------

type Handler = (payload: unknown) => void;
const channels = new Map<string, Set<Handler>>();

export function demoListen<T>(channel: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  const handler = cb as Handler;
  set.add(handler);
  start();
  return Promise.resolve(() => {
    set!.delete(handler);
  });
}

function emit(channel: string, payload: unknown) {
  const set = channels.get(channel);
  if (!set) return;
  for (const h of [...set]) h(payload);
}

const session = (e: SessionEvent) => emit('francois://session/event', e);
const agents = (e: AgentEvent) => emit('francois://agents/event', e);
const shell = (e: ShellEvent) => emit('francois://shell/event', e);

// ---------- mutable demo state ----------

// Deliberately EMPTY at module scope and filled by start(). Rollup treats a
// top-level call like `SESSIONS.map(...)` as a possible side effect and keeps
// it — which anchors the fixtures it reads and drags them into the shipped
// bundle even though every consumer is dead code. Nothing here may run until
// the flag is on; start() is the only writer and every entry point calls it.
let sessions: SessionMeta[] = [];
let liveAgents: AgentInfo[] = [];
let liveSteps: Record<string, AgentStep[]> = {};
// multiple-shells: a session's shells, built lazily the same way the real
// core does (§FR-5's create-if-none path) — never seeded, only ever grown by
// shell_ensure/shell_create so the capture always exercises the real flow.
let demoShells: Record<string, ShellInfo[]> = {};
let demoShellSeq = 0;

const find = (id: string) => sessions.find((s) => s.id === id);

function demoShellOrdinal(list: ShellInfo[]): number {
  const used = new Set(list.map((s) => Number(s.name.replace(/^zsh /, '')) || 0));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// unbound-panes FR-6: a shell's owner is a union now — the demo fixture keys
// its roster off a flat string derived from the owner, same as the real
// core's Registry (`first_of_owner` etc.).
function ownerKeyOf(owner: ShellOwner): string {
  return owner.kind === 'session' ? `session:${owner.sessionId}` : `project:${owner.projectId}`;
}
function ownerCwd(owner: ShellOwner): string {
  if (owner.kind === 'session') return find(owner.sessionId)?.cwd ?? '~';
  return PROJECTS.find((p) => p.id === owner.projectId)?.root ?? '~';
}
function readOwner(a: Args): ShellOwner {
  const owner = a?.owner as ShellOwner | undefined;
  return owner ?? { kind: 'session', sessionId: sid(a) };
}

function newDemoShell(owner: ShellOwner): ShellInfo {
  demoShellSeq += 1;
  const key = ownerKeyOf(owner);
  const list = demoShells[key] ?? [];
  const info: ShellInfo = {
    id: `demo-shell-${demoShellSeq}`,
    owner,
    name: `zsh ${demoShellOrdinal(list)}`,
    shellName: 'zsh',
    cwd: ownerCwd(owner),
    alive: true,
  };
  demoShells[key] = [...list, info];
  return info;
}

function findDemoShell(shellId: string): { key: string; owner: ShellOwner; list: ShellInfo[]; index: number } | null {
  for (const key of Object.keys(demoShells)) {
    const list = demoShells[key];
    const index = list.findIndex((s) => s.id === shellId);
    if (index >= 0) return { key, owner: list[index].owner, list, index };
  }
  return null;
}

// ---------- command router ----------

type Args = Record<string, unknown> | undefined;
const sid = (a: Args) => String(a?.sessionId ?? '');

export function demoInvoke<T>(cmd: string, args?: object): Promise<T> {
  start();
  const a = args as Args;
  return Promise.resolve(route(cmd, a) as T);
}

function route(cmd: string, a: Args): unknown {
  switch (cmd) {
    // ---- app ----
    case 'app_set_window_theme':
      return ok(null);
    case 'app_get_usage':
      return ok(USAGE[String(a?.accountId ?? 'default')] ?? USAGE.default);
    case 'app_refresh_usage':
      return ok({ started: false });
    case 'app_check_update':
      return ok({
        current: '0.17.8',
        latest: '0.17.8',
        updateAvailable: false,
        method: 'npm',
        notesUrl: 'https://github.com/antoine-gmnz/francois/releases/tag/v0.17.8',
        command: 'npm i -g francois@latest',
        checkedAt: T0,
      });

    // ---- accounts / projects ----
    case 'account_list':
      return ok(ACCOUNTS);
    case 'project_list':
      // project-groups §5: the response shape is now { projects, groups } — the
      // demo fixture has no groups of its own, so the roster's second tier
      // simply never appears here.
      return ok({ projects: PROJECTS, groups: [] });
    // The SESSION welcome header's repo facts — a plausible repo, so the capture
    // shows the header populated rather than half-empty.
    case 'project_repo_brief':
      return ok({
        root: '/francois',
        claudeMd: { lines: 41, modifiedAt: T0 - 6 * 86_400_000 },
        git: { branch: 'router-adapter', detached: false, base: 'main', ahead: 4 },
      });

    // ---- sessions ----
    case 'session_list':
      return ok(sessions);
    case 'session_models':
      return ok(MODELS);
    case 'session_list_commands':
      return ok(COMMANDS);
    case 'session_send': {
      const s = find(sid(a));
      if (s) {
        s.status = 'running';
        session({ type: 'session.meta', meta: { ...s } });
        session({
          type: 'message.user',
          sessionId: s.id,
          blockId: String(a?.blockId ?? 'blk-user'),
          text: String(a?.text ?? ''),
        });
      }
      return ok({ queued: false });
    }
    case 'session_interrupt':
    case 'session_compact':
    case 'session_clear':
    case 'session_remove':
      return ok(null);
    case 'session_switch_model': {
      const s = find(sid(a));
      const model = MODELS.find((m) => m.id === a?.modelId);
      if (s && model) {
        s.model = model;
        session({ type: 'session.meta', meta: { ...s } });
      }
      return ok(s ? { ...s } : null);
    }
    case 'session_rename': {
      const s = find(sid(a));
      if (s) {
        s.name = String(a?.name ?? s.name);
        session({ type: 'session.meta', meta: { ...s } });
      }
      return ok(s ? { ...s } : null);
    }

    // ---- conversation ----
    case 'conversation_get_transcript':
      return ok(sid(a) === S_API ? transcriptNow() : []);

    // ---- agents ----
    case 'agents_list':
      return ok(liveAgents.filter((x) => x.sessionId === sid(a)));
    case 'agents_activity':
      return ok(liveSteps[String(a?.agentId ?? '')] ?? []);
    case 'agents_transcript':
      return ok({ blocks: agentBlocks(String(a?.agentId ?? '')), dropped: 0 });
    case 'agents_kill':
      return ok(null);

    // ---- mcp ----
    case 'mcp_list':
      return ok(sid(a) === S_API ? MCP : MCP.slice(0, 2));
    case 'mcp_approvals':
      return ok({
        pending: [],
        approved: ['postgres', 'sentry'],
        rejected: [],
        trustRequired: false,
        enableAllProjectMcpServers: false,
      });
    case 'mcp_registry':
      return ok([]);
    case 'mcp_detail':
      return ok({ ...(MCP.find((m) => m.name === a?.name) ?? MCP[0]), transport: 'stdio', command: 'npx -y @orbit/mcp' });

    // ---- skills / workflows ----
    case 'skills_list':
      return ok(SKILLS);
    case 'workflows_list':
      return ok(WORKFLOWS.filter((w) => w.sessionId === sid(a)));

    // ---- diff ----
    case 'diff_get_summary':
      return ok(DIFF[sid(a)] ?? { files: [], totalAdd: 0, totalDel: 0 });
    case 'diff_get_file_diff':
      return ok(fileDiff(String(a?.path ?? '')));
    case 'diff_stage_all':
      return ok(null);
    case 'diff_commit':
      return ok({ commitHash: '4f1c9ad2e7b6135a08d4c9f2ab77e315c9d0e142' });

    // ---- permissions ----
    case 'permissions_list':
    case 'permissions_set_enabled':
    case 'permissions_remove':
    case 'permissions_set_tier':
      return ok([
        { id: 'local|allow|Bash(npm test:*)', pattern: 'Bash(npm test:*)', effect: 'allow', tier: 'local', enabled: true, label: 'npm test (any arguments)' },
        { id: 'local|allow|Read(src/**)', pattern: 'Read(src/**)', effect: 'allow', tier: 'local', enabled: true, label: 'read anything under src/' },
        { id: 'global|deny|Bash(rm -rf:*)', pattern: 'Bash(rm -rf:*)', effect: 'deny', tier: 'global', enabled: true, label: 'rm -rf (any arguments)' },
      ]);
    case 'permissions_decide':
      return ok(null);

    // ---- remote ----
    case 'remote_get':
    case 'remote_stop':
      return ok({ sessionId: sid(a), state: { phase: 'off' } });

    // ---- shell (multiple-shells: ShellId-keyed, up to 6 per owner; unbound-panes: owner is a union) ----
    case 'shell_ensure': {
      const owner = readOwner(a);
      const key = ownerKeyOf(owner);
      const requestedId = a?.shellId as string | undefined;
      let list = demoShells[key] ?? [];
      let target = requestedId ? list.find((s) => s.id === requestedId) : list[0];
      if (!target) {
        if (requestedId) return { ok: false, error: { code: 'SHELL_NOT_FOUND', message: 'shell not found' } };
        target = newDemoShell(owner); // FR-5 create-if-none
        list = demoShells[key];
      }
      return ok({
        shellId: target.id,
        shells: list,
        cols: 120,
        rows: 30,
        scrollbackReplay: list.length === 1 && target.alive ? `${SHELL_BANNER}\r\n` : '',
        exitCode: target.alive ? undefined : target.exitCode,
      });
    }
    case 'shell_create': {
      const owner = readOwner(a);
      const key = ownerKeyOf(owner);
      const list = demoShells[key] ?? [];
      if (list.length >= 6) return { ok: false, error: { code: 'SHELL_LIMIT_REACHED', message: '6 shells maximum' } };
      return ok(newDemoShell(owner));
    }
    case 'shell_restart': {
      const found = findDemoShell(String(a?.shellId ?? ''));
      if (!found) return { ok: false, error: { code: 'SHELL_NOT_FOUND', message: 'shell not found' } };
      const { key, list, index } = found;
      demoShells[key] = list.map((s, i) => (i === index ? { ...s, alive: true, exitCode: undefined } : s));
      return ok({ cols: 120, rows: 30 });
    }
    case 'shell_rename': {
      const found = findDemoShell(String(a?.shellId ?? ''));
      if (!found) return { ok: false, error: { code: 'SHELL_NOT_FOUND', message: 'shell not found' } };
      const { key, list, index } = found;
      const trimmed = String(a?.name ?? '').trim().slice(0, 40);
      const others = list.filter((_, i) => i !== index);
      const name = trimmed || `zsh ${demoShellOrdinal(others)}`;
      const next = list.map((s, i) => (i === index ? { ...s, name } : s));
      demoShells[key] = next;
      return ok(next[index]);
    }
    case 'shell_dispose': {
      const shellId = String(a?.shellId ?? '');
      const found = findDemoShell(shellId);
      if (found) demoShells[found.key] = found.list.filter((s) => s.id !== shellId);
      return ok(null);
    }
    case 'shell_write': {
      const shellId = String(a?.shellId ?? '');
      const found = findDemoShell(shellId);
      const data = String(a?.data ?? '');
      shell({
        type: 'shell.data',
        shellId,
        owner: found?.owner ?? { kind: 'session', sessionId: '' },
        data: data === '\r' ? '\r\n❯ ' : data,
      });
      return ok(null);
    }
    case 'shell_resize':
      return ok(null);

    // extensions: the demo fleet ships no providers, so the registry reads
    // empty and no ext tab is offered. Explicit because the default below
    // resolves ok(null), which is not a list.
    case 'extensions_list':
    case 'extensions_set_enabled':
    case 'extensions_detect':
      return ok([]);

    default:
      // Anything not scripted resolves benignly rather than exploding a panel.
      return ok(null);
  }
}

// ---------- derived views ----------

/**
 * A re-read (session switch, tab remount) has to agree with what the stream
 * already emitted, so every block the timeline appends is recorded here too —
 * INCLUDING one still streaming, exactly like the core's own block buffer.
 *
 * The app buffers every session event from the moment it subscribes and drains
 * that buffer onto the snapshot once `conversation_get_transcript` resolves
 * (useHydratedSubscription). A block present in BOTH is reconciled by each
 * delta's `offset` (contract/common.ts), so the overlap applies once — which is
 * why an in-flight block belongs in the snapshot: leaving it out is what made a
 * mid-paragraph remount lose the paragraph's opening.
 *
 * Copies go out, since the timeline keeps mutating the block it is streaming.
 */
const liveBlocks: ConversationBlock[] = [];

function transcriptNow() {
  return [...TRANSCRIPT, ...liveBlocks].map((b) => ({ ...b }));
}

/** An agent's own transcript, rebuilt from its activity trail. */
function agentBlocks(agentId: string): AgentBlock[] {
  const steps = liveSteps[agentId] ?? [];
  return steps.map((s): AgentBlock => {
    if (s.kind === 'tool') {
      const glyph = s.tool === 'Read' ? '⧉' : s.tool === 'Grep' ? '⌕' : s.tool === 'Write' || s.tool === 'Edit' ? '✎' : '●';
      return {
        kind: 'tool',
        blockId: `${agentId}-${s.seq}`,
        isStreaming: false,
        tool: s.tool ?? 'Bash',
        glyph: glyph as '⧉' | '⌕' | '✎' | '●',
        glyphColor: glyph === '✎' ? '#8fbab8' : '#8b93a3',
        bodyColor: '#8b93a3',
        summary: s.label,
        meta: s.meta,
      };
    }
    if (s.kind === 'notice') {
      return { kind: 'notice', blockId: `${agentId}-${s.seq}`, isStreaming: false, text: s.label };
    }
    return {
      kind: 'assistant',
      blockId: `${agentId}-${s.seq}`,
      isStreaming: false,
      glyph: '●',
      glyphColor: '#8b93a3',
      bodyColor: '#c3c9d4',
      text: s.label,
    };
  });
}

// ---------- timeline ----------
//
// Two independent loops, started on the first call from the app:
//
//  - `runTurns` plays whole turns end to end — a prompt, streamed assistant
//    prose, tool calls, a closing paragraph — appending fresh blocks each cycle.
//    It appends rather than rewinding because `assistant.delta` is ADDITIVE
//    (conversation-blocks.ts): replaying a block would concatenate onto itself.
//  - `runAgents` ticks the two running subagents and the context meter.
//
// Between them the app is never a still frame, so a recording started at any
// moment catches something happening.

let started = false;
const timers: Array<ReturnType<typeof setInterval>> = [];
let stopped = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function start() {
  if (!__FRANCOIS_DEMO__ || started) return;
  started = true;
  stopped = false;

  sessions = SESSIONS.map((s) => ({ ...s }));
  liveAgents = AGENTS.map((a) => ({ ...a }));
  liveSteps = Object.fromEntries(Object.entries(AGENT_STEPS).map(([k, v]) => [k, v.map((s) => ({ ...s }))]));
  demoShells = {};
  demoShellSeq = 0;

  void openingView();

  void runTurns();
  runAgents();
}

/** Stream one assistant paragraph in at a readable typing speed. */
async function stream(blockId: string, text: string) {
  const block: ConversationBlock = {
    kind: 'assistant',
    blockId,
    isStreaming: true,
    glyph: '●',
    glyphColor: '#c3f53f',
    bodyColor: '#e6e9ef',
    text: '',
  };
  liveBlocks.push(block); // in the snapshot from the first chunk on — offsets reconcile the overlap
  for (let i = 0; i < text.length && !stopped; i += 3) {
    const chunk = text.slice(i, i + 3);
    const offset = block.text.length;
    block.text += chunk;
    session({ type: 'assistant.delta', sessionId: S_API, blockId, text: chunk, offset });
    await sleep(24);
  }
  block.isStreaming = false;
  block.glyphColor = '#8b93a3';
  block.bodyColor = '#c3c9d4';
  session({ type: 'assistant.done', sessionId: S_API, blockId, text: block.text });
}

/** A tool call that opens, works for a beat, then resolves with its meta. */
async function toolCall(blockId: string, tool: string, summary: string, meta: string, ms = 900) {
  const block: ConversationBlock = {
    kind: 'tool',
    blockId,
    isStreaming: true,
    tool,
    glyph: tool === 'Read' ? '⧉' : tool === 'Grep' ? '⌕' : tool === 'Edit' || tool === 'Write' ? '✎' : '●',
    glyphColor: tool === 'Edit' || tool === 'Write' ? '#8fbab8' : '#8b93a3',
    bodyColor: '#8b93a3',
    summary,
  };
  liveBlocks.push(block);
  session({ type: 'tool.start', sessionId: S_API, blockId, tool, summary });
  await sleep(ms);
  block.isStreaming = false;
  block.meta = meta;
  session({ type: 'tool.done', sessionId: S_API, blockId, meta });
}

function userSays(blockId: string, text: string) {
  liveBlocks.push({ kind: 'user', blockId, isStreaming: false, queued: false, text });
  session({ type: 'message.user', sessionId: S_API, blockId, text });
}

function setStatus(status: 'running' | 'idle') {
  const hero = find(S_API);
  if (!hero) return;
  hero.status = status;
  hero.lastActivityAt = Date.now();
  session({ type: 'session.meta', meta: { ...hero } });
}

/** One turn's worth of work, parameterized by cycle so block ids never collide. */
const TURNS: Array<{
  prompt: string;
  open: string;
  beats: Array<[string, string, string, string]>;
  close: string;
}> = [
  {
    prompt: 'Good. Now check the other three services that call withRetry — same bug?',
    open: 'Worth checking — the wrapper is shared, so if the params are rebuilt anywhere else the same retry drops them. Let me find every caller and read the ones that pass a request through.',
    beats: [
      ['Grep', 'withRetry(  ·  services', '9 matches in 4 files', ''],
      ['Read', 'services/billing/src/charge.ts', '176 lines', ''],
      ['Edit', 'services/billing/src/charge.ts', '+11 −6', ''],
    ],
    close:
      'Two of the three had it: billing rebuilt the params the same way, and worker read them twice. Notifications was already capturing up front, so it is untouched. Both fixes are the same three lines as the auth one.',
  },
  {
    prompt: 'Ship it — commit each service separately.',
    open: 'Running the whole suite first, so a green run covers all three services at once. Then one commit per service, each carrying only its own fix and the test that proves it.',
    beats: [
      ['Bash', 'npm test -- --run', '412 passed, 0 failed · 18.7s', ''],
      ['Bash', 'git commit -m "fix(auth): carry state across retries"', '3 files changed', ''],
      ['Bash', 'git commit -m "fix(billing): capture params before first attempt"', '2 files changed', ''],
    ],
    close:
      'Three commits, one per service, each with just its own fix and test. The full suite is green at 412 passing. Nothing is pushed yet — say the word and I will open the PRs.',
  },
];

async function runTurns() {
  let cycle = 0;
  while (!stopped) {
    const turn = TURNS[cycle % TURNS.length];
    const tag = `c${cycle}`;

    await sleep(2400);
    if (stopped) return;

    userSays(`${tag}-u`, turn.prompt);
    setStatus('running');
    await sleep(700);

    await stream(`${tag}-a0`, turn.open);

    let i = 0;
    for (const [tool, summary, meta] of turn.beats) {
      if (stopped) return;
      await toolCall(`${tag}-t${i++}`, tool, summary, meta);
      await sleep(300);
    }

    await stream(`${tag}-a1`, turn.close);
    setStatus('idle');

    // Keep the transcript from growing without bound over a long capture.
    if (liveBlocks.length > 40) liveBlocks.splice(0, liveBlocks.length - 40);
    cycle++;
  }
}

function runAgents() {
  let tick = 0;
  timers.push(
    setInterval(() => {
      tick++;

      const hero = find(S_API);
      if (hero && hero.status === 'running') {
        hero.contextUsedTokens += 220;
        session({
          type: 'context.usage',
          sessionId: S_API,
          usedTokens: hero.contextUsedTokens,
          limitTokens: hero.contextLimitTokens,
        });
      }

      if (tick % 5 !== 0) return;
      for (const agent of liveAgents.filter((x) => x.status === 'running')) {
        const trail = (liveSteps[agent.id] ??= []);
        const seq = (trail[trail.length - 1]?.seq ?? 0) + 1;
        const step = nextStep(agent.name, seq);
        trail.push(step);
        agent.stepCount += 1;
        agent.lastActivity = step.label;
        liveSteps[agent.id] = trail.slice(-200);
        session({ type: 'agent.step', sessionId: S_API, agentId: agent.id, step });
        session({ type: 'agent.update', agent: { ...agent } });
        agents({ type: 'agent.block', sessionId: S_API, agentId: agent.id, block: agentBlocks(agent.id).slice(-1)[0] });
      }
    }, 600),
  );
}

const TOOL_STEPS: Array<Omit<AgentStep, 'seq' | 'at'>> = [
  { kind: 'tool', tool: 'Read', label: 'src/auth/token.ts', meta: '141 lines' },
  { kind: 'tool', tool: 'Grep', label: 'mintState(  ·  src', meta: '4 matches in 2 files' },
  { kind: 'text', label: 'Only the retry wrapper rebuilt the params — the rest carry them through.' },
  { kind: 'tool', tool: 'Edit', label: 'src/auth/retry.test.ts', meta: '+12 −3' },
  { kind: 'tool', tool: 'Bash', label: 'npm test -- auth/retry', meta: '9 passed · 0.4s' },
  { kind: 'tool', tool: 'Read', label: 'src/http/middleware.ts', meta: '88 lines' },
];

function nextStep(name: string, seq: number): AgentStep {
  const pick = TOOL_STEPS[(seq + name.length) % TOOL_STEPS.length];
  return { ...pick, seq, at: Date.now() };
}

/** Test seam / manual escape hatch — stops both loops. */
export function stopDemo() {
  stopped = true;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  started = false;
}

// multiple-shells FR-22 — the four "Shell: …" palette commands: gating on an
// active session, and that only "Shell: new" switches the main tab (the
// others act on the session's SHELL state directly, per the spec's wording).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { registerBuiltinCommands } from './paletteCommands';
import { paletteCommands } from './palette';
import { shellPaneEligibleProjects } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { useShellStore } from '../shell/shellStore';
import type { PaletteContext, SecondaryStep } from '../../../contract/command-palette';
import type { ShellInfo } from '../../../contract/shell-terminal';

function shell(id: string): ShellInfo {
  return { id, owner: { kind: 'session', sessionId: 's1' }, name: `zsh ${id}`, shellName: 'zsh', cwd: '/tmp', alive: true };
}

function findCommand(id: string) {
  const cmd = paletteCommands().find((c) => c.id === id);
  if (!cmd) throw new Error(`${id} not registered`);
  return cmd;
}

const activeCtx: PaletteContext = { activeSessionId: 's1', runningAgentCount: 0 };
const noSessionCtx: PaletteContext = { activeSessionId: null, runningAgentCount: 0 };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: true, data: [] }); // covers the sessionModels() prefetch at bootstrap
  useStore.setState({ mainTab: 'session', focusedPane: 'sidebar', projects: [], extraPanes: [], focusedPaneIndex: 0 });
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  registerBuiltinCommands(); // idempotent — safe across tests
});

describe('Shell: new/close/next/rename gating', () => {
  it('all four are disabled with no active session', () => {
    for (const id of ['shell-new', 'shell-close', 'shell-next', 'shell-rename']) {
      expect(findCommand(id).enabled?.(noSessionCtx)).toBe(false);
    }
  });

  it('all four are enabled with an active session', () => {
    for (const id of ['shell-new', 'shell-close', 'shell-next', 'shell-rename']) {
      expect(findCommand(id).enabled?.(activeCtx)).toBe(true);
    }
  });
});

describe('Shell: new', () => {
  it('switches focus + main tab to SHELL, then creates a shell (FR-22)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: shell('a') });
    findCommand('shell-new').run(activeCtx);
    expect(useStore.getState().focusedPane).toBe('main');
    expect(useStore.getState().mainTab).toBe('shell');
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' } });
  });
});

describe('Shell: close', () => {
  it('disposes the displayed shell WITHOUT switching the main tab', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    findCommand('shell-close').run(activeCtx);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'a' });
    expect(useStore.getState().mainTab).toBe('session'); // untouched
  });
});

describe('Shell: next', () => {
  it('cycles the active chip without any IPC call', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    findCommand('shell-next').run(activeCtx);

    expect(useShellStore.getState().activeShellId.s1).toBe('b');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('Shell: rename', () => {
  it('flags the displayed chip for inline rename (no free-text SecondaryStep)', () => {
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    const result = findCommand('shell-rename').run(activeCtx);

    expect(result).toBeUndefined(); // closes the palette like every other direct-action command
    expect(useShellStore.getState().renameRequest).toBe('a');
  });
});

// ── unbound-panes FR-9 — "Open shell pane…" ──────────────────────────────────

function project(id: string, name: string, rootExists = true) {
  return { id, name, root: `/repos/${name}`, rootExists, defaults: {}, createdAt: 0, lastUsedAt: 0 } as never;
}

describe('Open shell pane… (unbound-panes FR-9)', () => {
  it('is disabled with no registered project, and enabled with one', () => {
    useStore.setState({ projects: [], extraPanes: [] });
    expect(findCommand('open-shell-pane').enabled?.(activeCtx)).toBe(false);

    useStore.setState({ projects: [project('p1', 'acme-api')] });
    expect(findCommand('open-shell-pane').enabled?.(activeCtx)).toBe(true);
  });

  it('needs NO session — a shell pane is rooted at a project, not a session', () => {
    useStore.setState({ projects: [project('p1', 'acme-api')], extraPanes: [] });
    expect(findCommand('open-shell-pane').enabled?.(noSessionCtx)).toBe(true);
  });

  it('is disabled once the grid is full — there is no slot to open into', () => {
    useStore.setState({
      projects: [project('p1', 'acme-api')],
      extraPanes: [
        { kind: 'session', sessionId: 's2', tab: 'session' },
        { kind: 'session', sessionId: 's3', tab: 'session' },
        { kind: 'session', sessionId: 's4', tab: 'session' },
      ],
    });
    expect(findCommand('open-shell-pane').enabled?.(activeCtx)).toBe(false);
  });

  it('ignores a project whose root is gone — it cannot root a PTY', () => {
    useStore.setState({ projects: [project('p1', 'acme-api', false)], extraPanes: [] });
    expect(findCommand('open-shell-pane').enabled?.(activeCtx)).toBe(false);
  });

  it('unbound-panes edge case 4: a project already at its per-owner shell cap is excluded from the picker, even with grid room to spare', () => {
    // The grid itself only ever holds 3 extra panes at once (MAX_PANES=4), so
    // this cap is normally reached over TIME (shells opened, closed, opened
    // again isn't how it's tracked — it's live count) rather than by filling
    // the grid; the cap check must still hold independently of `canOpenShellPane`.
    useStore.setState({
      projects: [project('p1', 'acme-api'), project('p2', 'francois')],
      extraPanes: [
        { kind: 'shell', projectId: 'p1', shellId: 'sh-0' },
        { kind: 'shell', projectId: 'p1', shellId: 'sh-1' },
      ],
    });
    // p1 is nowhere near cap yet with only 2 open — sanity check both offered.
    const step = findCommand('open-shell-pane').run(activeCtx) as SecondaryStep | undefined;
    expect(step!.items.map((i) => i.id)).toEqual(['p1', 'p2']);

    // Excluding it directly through the shared selector (the palette's own
    // gate) proves the wiring without needing 6 live panes, which the 4-pane
    // grid can never hold at once.
    const atCap = [
      { id: 'p1', rootExists: true },
      { id: 'p2', rootExists: true },
    ];
    const capExtras = Array.from({ length: 6 }, (_, i) => ({ kind: 'shell' as const, projectId: 'p1', shellId: `s${i}` }));
    expect(shellPaneEligibleProjects(atCap, capExtras).map((p) => p.id)).toEqual(['p2']);
  });

  it('opens the pane STRAIGHT AWAY when exactly one project is registered (no picker)', () => {
    useStore.setState({ projects: [project('p1', 'acme-api')], extraPanes: [], activeSessionId: 's1' });
    const step = findCommand('open-shell-pane').run(activeCtx) as SecondaryStep | undefined;
    expect(step).toBeUndefined(); // no SecondaryStep — the palette just closes
    expect(useStore.getState().extraPanes).toEqual([{ kind: 'shell', projectId: 'p1', shellId: null }]);
  });

  it('offers a project picker above one project, and opens the picked one', () => {
    useStore.setState({
      projects: [project('p1', 'acme-api'), project('p2', 'francois')],
      extraPanes: [],
      activeSessionId: 's1',
    });
    const step = findCommand('open-shell-pane').run(activeCtx) as SecondaryStep | undefined;
    expect(step).toBeDefined();
    expect(step!.items.map((i) => i.id)).toEqual(['p1', 'p2']);
    expect(step!.items.map((i) => i.label)).toEqual(['acme-api', 'francois']);

    step!.onPick('p2');
    expect(useStore.getState().extraPanes).toEqual([{ kind: 'shell', projectId: 'p2', shellId: null }]);
  });
});

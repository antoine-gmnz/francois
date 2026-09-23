// cohorte-integration FR-88 — the ⌘K commands. Each is shown only when it
// applies: the run ones to the active session's linked run, the project ones
// to the active project's detection. Destructive ones confirm through a
// secondary step (the palette's own two-step flow).

import type { CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';
import { cohorteDoctor } from '../../lib/api';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useStore } from '../../lib/store';
import { registerPaletteCommand, showToast } from '../palette/palette';
import { answerGate, controlRun, openCohorteRun } from './actions';
import { computeLinks, detectionFor, linkForSession } from './linkage';
import { runControls, shortRunId } from './run-view';
import { watchedRunList } from './watch';
import { requestCohorteSettings } from './settings-request';
import { CASE_INSENSITIVE_FS, detectProject } from './useCohorte';

function activeRun(sessionId: string | null): CohorteRun | null {
  if (!sessionId) return null;
  const c = useCohorteStore.getState();
  const links = computeLinks({
    sessions: useStore.getState().sessions,
    runs: watchedRunList(c.runs, c.watchedRoots, CASE_INSENSITIVE_FS),
    detections: c.detections,
    explicitLinks: c.explicitLinks,
    caseInsensitive: CASE_INSENSITIVE_FS,
  });
  const link = linkForSession(links, sessionId);
  return link ? (c.runs[link.runId] ?? null) : null;
}

function projectRoot(): string | null {
  const st = useStore.getState();
  return st.projects.find((p) => p.id === st.activeProjectId)?.root ?? null;
}

function projectDetection() {
  const root = projectRoot();
  return root ? detectionFor(useCohorteStore.getState().detections, root, CASE_INSENSITIVE_FS) : null;
}

function hasAction(run: CohorteRun | null, id: CohorteGateActionId): boolean {
  return run?.gate?.actions.some((a) => a.id === id) ?? false;
}

let registered = false;

/** Idempotent — call once at app bootstrap. */
export function registerCohortePaletteCommands(): void {
  if (registered) return;
  registered = true;

  registerPaletteCommand({
    id: 'cohorte-open-run',
    glyph: '›',
    name: 'Cohorte: Open run',
    hint: () => {
      const run = activeRun(useStore.getState().activeSessionId);
      return run ? shortRunId(run.runId) : '';
    },
    enabled: (ctx) => activeRun(ctx.activeSessionId) !== null,
    run: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      if (run) openCohorteRun(run.runId);
    },
  });

  const gateCommand = (id: CohorteGateActionId, name: string) =>
    registerPaletteCommand({
      id: `cohorte-${id}-gate`,
      glyph: id === 'approve' ? '✓' : id === 'fix' ? '↺' : '✕',
      name,
      hint: () => (id === 'approve' ? '1' : id === 'fix' ? '2' : '3'),
      enabled: (ctx) => hasAction(activeRun(ctx.activeSessionId), id),
      run: (ctx) => {
        const run = activeRun(ctx.activeSessionId);
        if (!run) return;
        const stops = run.gate?.actions.find((a) => a.id === 'deny')?.stopsRun ?? false;
        if (id === 'deny' && stops) {
          return {
            placeholder: `Deny and cancel ${shortRunId(run.runId)}?`,
            items: [
              { id: 'confirm', label: 'Deny and cancel the run', hint: 'cohorte deny + cancel' },
              { id: 'back', label: 'Back' },
            ],
            onPick: (pick) => {
              if (pick === 'confirm') void answerGate(run, 'deny', ctx.activeSessionId);
            },
          };
        }
        void answerGate(run, id, ctx.activeSessionId);
      },
    });
  gateCommand('approve', 'Cohorte: Approve gate');
  gateCommand('fix', 'Cohorte: Send gate to fix');
  gateCommand('deny', 'Cohorte: Deny gate');

  registerPaletteCommand({
    id: 'cohorte-pause-run',
    glyph: '‖',
    name: 'Cohorte: Pause run',
    enabled: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      return run !== null && runControls(run.view).pause;
    },
    run: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      if (run) void controlRun(run, 'pause');
    },
  });
  registerPaletteCommand({
    id: 'cohorte-resume-run',
    glyph: '▸',
    name: 'Cohorte: Resume run',
    enabled: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      return run !== null && runControls(run.view).resume;
    },
    run: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      if (run) void controlRun(run, 'resume');
    },
  });
  registerPaletteCommand({
    id: 'cohorte-cancel-run',
    glyph: '■',
    name: 'Cohorte: Cancel run…',
    enabled: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      return run !== null && runControls(run.view).cancel;
    },
    run: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      if (!run) return;
      return {
        placeholder: `Cancel ${shortRunId(run.runId)}? Cohorte stops every agent and removes the run's worktrees.`,
        items: [
          { id: 'confirm', label: 'Cancel the run', hint: `cohorte cancel ${shortRunId(run.runId)}` },
          { id: 'back', label: 'Keep running' },
        ],
        onPick: (pick) => {
          if (pick === 'confirm') void controlRun(run, 'cancel');
        },
      };
    },
  });
  registerPaletteCommand({
    id: 'cohorte-show-logs',
    glyph: '≡',
    name: 'Cohorte: Show logs',
    enabled: (ctx) => activeRun(ctx.activeSessionId) !== null,
    run: (ctx) => {
      const run = activeRun(ctx.activeSessionId);
      if (!run) return;
      if (ctx.activeSessionId) useCohorteStore.getState().setPanelLog(ctx.activeSessionId, run.runId);
      useStore.getState().setSessionPanelTab('cohorte');
    },
  });

  registerPaletteCommand({
    id: 'cohorte-run-doctor',
    glyph: '✚',
    name: 'Cohorte: Run doctor',
    enabled: () => projectDetection()?.state === 'detected',
    run: () => {
      const root = projectDetection()?.root;
      if (!root) return;
      void cohorteDoctor({ root }).then((res) => {
        if (!res.ok) showToast(res.error.message, 'error');
        else showToast(res.data.ok ? 'cohorte doctor passed' : 'cohorte doctor found problems — see Settings · Cohorte', res.data.ok ? 'success' : 'error');
      });
    },
  });
  registerPaletteCommand({
    id: 'cohorte-settings',
    glyph: '⚙',
    name: 'Cohorte: Settings',
    enabled: () => projectRoot() !== null,
    run: () => requestCohorteSettings(),
  });
  registerPaletteCommand({
    id: 'cohorte-check-again',
    glyph: '↻',
    name: 'Cohorte: Check again',
    enabled: () => projectRoot() !== null,
    run: () => {
      const root = projectRoot();
      if (!root) return;
      void detectProject(root, true).then((d) =>
        showToast(d?.state === 'detected' ? 'Cohorte detected' : 'No .cohorte/ in this project', 'info'),
      );
    },
  });
}

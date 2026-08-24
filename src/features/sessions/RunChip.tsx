// design 11c ("the run chip's menu") — one chip for the two things that decide what
// a turn will be: the model it runs on and how much it is allowed to do. They used
// to be two chips with two popovers, which meant the answer to "what is about to
// happen here" lived in two places that could disagree.
//
// The panel holds exactly those two, in the chip's own order. Effort sits INSIDE the
// selected model's row, because it is a property of the model — pick another model
// and the segmented track moves with it, and a model that advertises no effort has
// no track at all. Permission rows are radio, not switches: one mode is always in
// force. Only `bypass` gets a tinted row and a second line saying how long it has
// been on and in which worktree — the same information you would want before
// leaving it on.
//
// response-mode adds a THIRD section under Permissions — how the model is told to
// write back. Last of the three because it is the least consequential: the model
// decides what runs, permissions decide what it may do, response decides how it
// reads back. No row is tinted there, deliberately: tint means consequence, and no
// writing style has one.
//
// Same panel shell, width and footer grammar as 11a's `◈` menu, so the bar has one
// menu language rather than four bespoke popovers.

import { useRef, useState } from 'react';
import type { ModelInfo, PermissionMode, ResponseMode, SessionMeta } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import {
  projectUpdate,
  sessionSwitchEffort,
  sessionSwitchModel,
  sessionSwitchPermissionMode,
  sessionSwitchResponseMode,
} from '../../lib/api';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useMounted } from '../../lib/hooks/useMounted';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { useStore } from '../../lib/store';
import { useModelCatalog } from './useModelCatalog';
import {
  APPLIES_COPY,
  SET_PROJECT_DEFAULT_COPY,
  SET_PROJECT_DEFAULT_TITLE,
  bypassNote,
  canSetProjectDefault,
  effortHint,
  effortLevels,
  nextProjectDefaults,
  runChipParts,
} from './run-chip';
import './run-chip.css';

export interface RunChipProps {
  session: SessionMeta;
  /**
   * design 11c: "at 720 this chip is inside `⋯` — the panel opens unchanged,
   * anchored to `⋯` instead, with the context and branch readouts stacked above the
   * Model heading." Those readouts are passed in rather than re-derived, because the
   * bar already computed them for its own row.
   */
  readouts?: { label: string; value: string }[];
  /** Rendered flat, without its own chip, when the overflow menu is hosting it. */
  bare?: boolean;
}

export default function RunChip({ session, readouts, bare = false }: RunChipProps) {
  const [open, setOpen] = useState(!!bare);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const alive = useMounted();
  const { error, setError, schedule } = useTimedError();
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);

  // The account's own catalog — the same source the New Session modal picks from,
  // so a chip on an endpoint session never offers Anthropic's list. Keyed on the
  // account, not the session, so switching between two sessions of the same account
  // costs no round-trip.
  const { models } = useModelCatalog(session.accountId);

  useDismiss(rootRef, {
    onEscape: () => !bare && setOpen(false),
    onOutsideClick: () => !bare && setOpen(false),
    enabled: open && !bare,
  });

  const parts = runChipParts(session);
  // The catalog may not have resolved yet (or may not carry this session's model at
  // all, for a hand-set id) — the session's own ModelInfo is always the truth about
  // what is selected, so it seeds the list rather than the list deciding.
  const catalog: ModelInfo[] = models.length > 0 ? models : [session.model];
  const current = catalog.find((m) => m.id === session.model.id) ?? session.model;
  const levels = effortLevels(current);
  const note = bypassNote(session);

  function fail(message: string) {
    setError(message);
    schedule(() => setError(null), 4000);
  }

  async function run<T>(call: Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>) {
    if (pending) return false;
    setPending(true);
    setError(null);
    const res = await call.catch(() => ({ ok: false as const, error: { message: 'Could not reach the core' } }));
    if (!alive.current) return false;
    setPending(false);
    if (!res.ok) {
      fail(res.error.message);
      return false;
    }
    return true;
  }

  // FR-12's rule, kept: the session.meta event that comes back over the wire is the
  // single update path. Nothing here writes the session into the store.
  const pickModel = async (modelId: string) => {
    if (modelId === session.model.id) return;
    if (await run(sessionSwitchModel(session.id, modelId))) {
      // Effort belongs to the model. Switching to one that advertises none, or one
      // whose ladder does not include the level in force, would otherwise leave a
      // level set that the next turn cannot honour.
      const next = catalog.find((m) => m.id === modelId);
      const keeps = next ? effortLevels(next).includes(session.effort ?? '') : false;
      if (session.effort && !keeps) await run(sessionSwitchEffort(session.id, null));
    }
  };

  const pickEffort = async (level: string) => {
    await run(sessionSwitchEffort(session.id, level === session.effort ? null : level));
  };

  const pickMode = async (mode: PermissionMode) => {
    if (await run(sessionSwitchPermissionMode(session.id, mode))) {
      if (!bare) setOpen(false);
    }
  };

  // response-mode FR-14/FR-18: the panel STAYS OPEN — like the model and effort
  // rows, and unlike the permission rows, because picking a writing style is a
  // thing you compare rather than commit to. Nothing is written to the store: the
  // session.meta event this Result accompanies is the only update path.
  const pickResponseMode = async (mode: ResponseMode) => {
    if (mode === session.responseMode) return;
    await run(sessionSwitchResponseMode(session.id, mode));
  };

  const setProjectDefault = async () => {
    const project = projects.find((p) => p.id === session.projectId);
    if (!project) return;
    const res = await projectUpdate({ projectId: project.id, defaults: nextProjectDefaults(project.defaults, session) });
    if (!alive.current) return;
    if (res.ok) setProjects(projects.map((p) => (p.id === res.data.id ? res.data : p)));
    else fail(res.error.message);
  };

  const panel = (
    <div role="menu" aria-label="model, permissions and response" className="run-chip__panel">
      {/* 11c at 720: what the bar stopped showing is stated here, above the first
          heading — readouts, so they sit outside both option lists. */}
      {readouts && readouts.length > 0 && (
        <div className="run-chip__readouts">
          {readouts.map((r) => (
            <div key={r.label} className="run-chip__readout">
              <span className="run-chip__readout-label">{r.label}</span>
              <span className="run-chip__readout-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="run-chip__head">
        <span className="run-chip__head-label">Model</span>
        <span className="app-flex-spacer" />
        <span className="run-chip__head-hint">/model</span>
      </div>

      <div className="run-chip__group">
        {catalog.map((m) => {
          const on = m.id === current.id;
          return (
            <div
              key={m.id}
              role="menuitemradio"
              aria-checked={on}
              tabIndex={-1}
              onClick={() => void pickModel(m.id)}
              className={on ? 'run-chip__option run-chip__option--on' : 'run-chip__option'}
            >
              <div className="run-chip__option-line">
                <span className={on ? 'run-chip__dot run-chip__dot--on' : 'run-chip__dot'}>●</span>
                <span className="run-chip__option-label truncate">{m.label}</span>
                <span className="run-chip__option-hint">{on ? 'current' : effortHint(m)}</span>
              </div>

              {on && levels.length > 0 && (
                <div className="run-chip__effort" onClick={(e) => e.stopPropagation()}>
                  {levels.map((level) => (
                    <span
                      key={level}
                      role="button"
                      title={
                        level === session.effort
                          ? `effort ${level} — click to fall back to the model default`
                          : `run at ${level} effort`
                      }
                      onClick={() => void pickEffort(level)}
                      className={
                        level === session.effort ? 'run-chip__effort-step run-chip__effort-step--on' : 'run-chip__effort-step'
                      }
                    >
                      {level}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="run-chip__rule" />

      <div className="run-chip__head">
        <span className="run-chip__head-label">Permissions</span>
        <span className="app-flex-spacer" />
        <span className="run-chip__head-hint">this session</span>
      </div>

      <div className="run-chip__group">
        {PERMISSION_MODE_OPTIONS.map((opt) => {
          const on = opt.mode === session.permissionMode;
          return (
            <div
              key={opt.mode}
              role="menuitemradio"
              aria-checked={on}
              tabIndex={-1}
              onClick={() => void pickMode(opt.mode)}
              className={
                'run-chip__option' +
                (on ? ' run-chip__option--on' : '') +
                (opt.danger && on ? ' run-chip__option--danger' : '')
              }
            >
              <div className="run-chip__option-line">
                <span
                  className={
                    'run-chip__dot' + (on ? (opt.danger ? ' run-chip__dot--danger' : ' run-chip__dot--on') : '')
                  }
                >
                  ●
                </span>
                <span className="run-chip__option-body">
                  <span className="run-chip__option-label">{opt.label}</span>
                  <span className={opt.danger && on ? 'run-chip__option-sub run-chip__option-sub--danger' : 'run-chip__option-sub'}>
                    {opt.hint}
                  </span>
                </span>
                <span className={opt.danger ? 'run-chip__option-hint run-chip__option-hint--danger' : 'run-chip__option-hint'}>
                  {opt.short}
                </span>
              </div>
              {on && note && <span className="run-chip__note">{note}</span>}
            </div>
          );
        })}
      </div>

      <div className="run-chip__rule" />

      <div className="run-chip__head">
        <span className="run-chip__head-label">Response</span>
        <span className="app-flex-spacer" />
        <span className="run-chip__head-hint">this session</span>
      </div>

      {/* response-mode FR-14: the same radio shape as Permissions, minus the danger
          tone — no writing style is risky, and a tint that means nothing teaches the
          eye to ignore the tint that does. */}
      <div className="run-chip__group">
        {RESPONSE_MODE_OPTIONS.map((opt) => {
          const on = opt.mode === session.responseMode;
          return (
            <div
              key={opt.mode}
              role="menuitemradio"
              aria-checked={on}
              tabIndex={-1}
              onClick={() => void pickResponseMode(opt.mode)}
              className={on ? 'run-chip__option run-chip__option--on' : 'run-chip__option'}
            >
              <div className="run-chip__option-line">
                <span className={on ? 'run-chip__dot run-chip__dot--on' : 'run-chip__dot'}>●</span>
                <span className="run-chip__option-body">
                  <span className="run-chip__option-label">{opt.label}</span>
                  <span className="run-chip__option-sub">{opt.hint}</span>
                </span>
                {on && <span className="run-chip__option-hint">current</span>}
              </div>
            </div>
          );
        })}
      </div>

      {error && <div className="run-chip__error">{error}</div>}

      <div className="run-chip__foot">
        <span className="run-chip__foot-copy">{APPLIES_COPY}</span>
        <span className="app-flex-spacer" />
        {canSetProjectDefault(session) && (
          <span
            role="button"
            tabIndex={0}
            className="run-chip__foot-action"
            title={SET_PROJECT_DEFAULT_TITLE}
            onClick={() => void setProjectDefault()}
          >
            {SET_PROJECT_DEFAULT_COPY}
          </span>
        )}
      </div>
    </div>
  );

  if (bare) return <div className="run-chip run-chip--bare">{panel}</div>;

  return (
    <div ref={rootRef} className="run-chip">
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={session.model.brief ?? `${parts.model} · ${parts.mode}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={open ? 'run-chip__chip run-chip__chip--on' : 'run-chip__chip'}
      >
        <span className="run-chip__model">{parts.model}</span>
        {parts.effort && <span className="run-chip__effort-tag">{parts.effort}</span>}
        <span className={parts.danger ? 'run-chip__mode run-chip__mode--danger' : 'run-chip__mode'}>{parts.mode}</span>
        {/* response-mode FR-15: last in the cluster, and only when it is not
            'default' — the common case leaves the row exactly as wide as it was. */}
        {parts.response && <span className="run-chip__response">{parts.response}</span>}
        <span className="run-chip__caret">▾</span>
      </span>
      {open && panel}
    </div>
  );
}

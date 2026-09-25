// cohorte-actions FR-32/FR-33 — the actions popover (frame 35): anchored above
// the composer, opened by the chip / `⌘⇧C` / `/cohorte` / the palette. Renders
// buildCohorteMenu's model (actions-menu.ts) and nothing else decides content.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import { cohorteFeatures } from '../../lib/api';
import { useCohorteActionsStore } from '../../lib/cohorteActionsStore';
import { useCohorteStore } from '../../lib/cohorteStore';
import { answerGate } from './actions';
import { buildCohorteMenu, flattenMenu, moveMenuSelection, type CohorteMenuRow } from './actions-menu';
import { cohortePlumbingLine } from './command-display';
import { useProjectDetection, useSessionRun } from './useCohorte';
import { openPlumbingTerminal } from './terminal';
import { CohorteMark } from './CohorteParts';
import { basename } from '../../lib/path';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { Kbd } from '../../ui/Kbd';
import './cohorte.css';

export interface CohorteActionsMenuProps {
  sessionId: SessionId;
  root: string;
  /** Closed, playing its exit animation (usePresence) — takes no input. */
  exiting?: boolean;
}

export default function CohorteActionsMenu({ sessionId, root, exiting = false }: CohorteActionsMenuProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const detection = useProjectDetection(root);
  const { run: linkedRun } = useSessionRun(sessionId);
  // Select the stable map, filter in useMemo: a selector that builds a new
  // array on every read makes useSyncExternalStore re-render forever.
  const runs = useCohorteStore((s) => s.runs);
  const runsForRoot = useMemo(() => Object.values(runs).filter((r) => r.projectRoot === root), [runs, root]);
  const [features, setFeatures] = useState<import('../../../contract/cohorte-actions').CohorteFeatureChoice[]>([]);

  useEffect(() => {
    let current = true;
    void cohorteFeatures(root).then((res) => {
      if (current && res.ok) setFeatures(res.data);
    });
    return () => {
      current = false;
    };
  }, [root]);

  const model = useMemo(() => buildCohorteMenu({ linkedRun, features, runsForRoot }), [linkedRun, features, runsForRoot]);
  const rows = useMemo(() => flattenMenu(model), [model]);
  const [selIdx, setSelIdx] = useState(0);
  useEffect(() => setSelIdx(0), [rows.length]);

  const close = () => useCohorteActionsStore.getState().closeMenu();

  const runRow = (row: CohorteMenuRow) => {
    if (row.kind === 'suggestion') {
      const { action } = row.suggestion;
      if (action.kind === 'gate') {
        if (linkedRun) void answerGate(linkedRun, action.gateAction, sessionId);
        close();
        return;
      }
      if (action.kind === 'start') {
        useCohorteActionsStore.getState().openSheet({ action: 'start', sessionId, featureId: action.featureId });
        return;
      }
      useCohorteActionsStore.getState().openSheet({ action: 'brainstorm', sessionId, featureId: action.featureId });
      return;
    }
    const { item } = row;
    if (item.kind === 'sheet') {
      useCohorteActionsStore.getState().openSheet({ action: item.id, sessionId });
      return;
    }
    // FR-21: patch/fleet/audit/retro — typed, not executed.
    const verb = item.id as 'patch' | 'fleet' | 'audit' | 'retro';
    openPlumbingTerminal(sessionId, verb, cohortePlumbingLine(verb));
    close();
  };

  useEffect(() => {
    if (exiting) return undefined;
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Element;
      // The composer's Cohorte button toggles the menu itself — closing here
      // too would let its click reopen it.
      if (target.closest?.('.composer-cohorte-chip')) return;
      if (rootRef.current && !rootRef.current.contains(target)) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setSelIdx((i) => moveMenuSelection(rows.length, i, 1));
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setSelIdx((i) => moveMenuSelection(rows.length, i, -1));
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const row = rows[selIdx];
        if (row) runRow(row);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selIdx, exiting]);

  const healthy = detection?.state === 'detected';
  const health = detection ? [detection.cli.version, healthy ? 'healthy' : detection.state].filter(Boolean).join(' · ') : '';

  const renderRow = (
    idx: number,
    key: string,
    row: CohorteMenuRow,
    content: { icon: IconName; label: string; description: string; hint: string; attention?: boolean },
  ) => {
    const selected = idx === selIdx;
    const cls = ['cohorte-actions-menu__row'];
    if (selected) cls.push('cohorte-actions-menu__row--sel');
    if (content.attention) cls.push('cohorte-actions-menu__row--attention');
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={selected}
        className={cls.join(' ')}
        onMouseMove={() => setSelIdx(idx)}
        onClick={() => runRow(row)}
      >
        <Icon name={content.icon} className="cohorte-actions-menu__icon" />
        <span className="cohorte-actions-menu__text">
          <span className="cohorte-actions-menu__row-title">
            <span className="cohorte-actions-menu__row-label truncate">{content.label}</span>
            {content.attention && <span className="cohorte-actions-menu__tag">gate</span>}
          </span>
          <span className="cohorte-actions-menu__row-desc truncate">{content.description}</span>
        </span>
        <span className="cohorte-actions-menu__row-hint truncate">{content.hint}</span>
        {selected && <Kbd keys="⏎" />}
      </button>
    );
  };

  let i = -1;
  return (
    <div ref={rootRef} className={exiting ? 'cohorte-actions-menu cohorte-actions-menu--exiting scz' : 'cohorte-actions-menu scz'} role="dialog" aria-label="Cohorte actions">
      <div className="cohorte-actions-menu__head">
        <CohorteMark size={16} />
        <span className="cohorte-actions-menu__title">Cohorte</span>
        <span className="cohorte-actions-menu__project truncate" title={detection?.root ?? root}>
          {basename(detection?.root ?? root)}
        </span>
        <span className="cohorte-spacer" />
        {detection && (
          <>
            <span className={healthy ? 'cohorte-actions-menu__dot' : 'cohorte-actions-menu__dot cohorte-actions-menu__dot--bad'} />
            <span className="cohorte-actions-menu__health">{health}</span>
          </>
        )}
      </div>
      <div className="cohorte-actions-menu__results" role="listbox">
        {model.suggestions.length > 0 && <div className="cohorte-actions-menu__label">Suggested for this session</div>}
        {model.suggestions.map((s) => {
          i += 1;
          return renderRow(i, s.id, { kind: 'suggestion', suggestion: s }, {
            icon: s.icon,
            label: s.label,
            description: s.description,
            hint: s.commandHint,
            attention: s.tone === 'attention',
          });
        })}
        {model.groups.map((group) => [
          <div key={`label-${group.label}`} className="cohorte-actions-menu__label">
            {group.label}
          </div>,
          ...group.items.map((item) => {
            i += 1;
            return renderRow(i, item.id, { kind: 'item', item }, {
              icon: item.icon,
              label: item.label,
              description: item.description,
              hint: item.commandHint,
            });
          }),
        ])}
      </div>
      <div className="cohorte-actions-menu__footer">
        <span className="cohorte-actions-menu__hint">
          <Kbd keys="↑↓" /> navigate
        </span>
        <span className="cohorte-actions-menu__hint">
          <Kbd keys="⏎" /> open
        </span>
        <span className="cohorte-actions-menu__hint">
          <Kbd keys="Esc" /> close
        </span>
        <span className="cohorte-spacer" />
        <span className="cohorte-actions-menu__footer-note">runs the CLI · not a Claude turn</span>
      </div>
    </div>
  );
}

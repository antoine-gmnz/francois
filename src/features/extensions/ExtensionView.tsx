// The body of an `ext:<id>` main tab (FR-15..FR-18): a header strip naming the
// extension and what it is scoped to, then ONE scrolling column of stacked
// sections in declaration order — not cards, so the column reads as one
// continuous document (design brief §1).
//
// Every section owns its own fetch and its own state; this component owns only
// what CROSSES sections: FR-38's token, which travels from a source table's
// selected row to the log-tail below it, and FR-58's `disable`.
//
// Project-scoped sections are keyed by the SESSION alongside the root — FR-12
// re-scopes on every session change, not only one that lands on a different
// root (two sessions can share a root) — so a session change always remounts
// them: cursors discarded, project-scoped streams restarted, fleet sections
// untouched.

import { useState } from 'react';
import type { PanelId, TableRow } from '../../../contract/extensions';
import { extensionsSetEnabled } from '../../lib/api';
import { useStore } from '../../lib/store';
import { EmptyPane } from '../../ui/EmptyPane';
import DashboardAction from './DashboardAction';
import LogTailSection from './LogTailSection';
import PanelSection from './PanelSection';
import { DISABLE_COPY, panelRoot, tokenFromRow } from './extensions';
import './extensions.css';

export interface ExtensionViewProps {
  extensionId: string;
  /** FR-3/FR-11: the active session's root, or null with no session (FR-14). */
  root: string | null;
  /**
   * FR-12: the active session's id, or null with no session. Two sessions can
   * share a root, so the root alone cannot tell a session change apart from a
   * no-op re-render — this is what actually drives the re-scope.
   */
  sessionId: string | null;
  /** For FR-13's `not available in <project>` copy. */
  projectName: string | null;
}

export default function ExtensionView({ extensionId, root, sessionId, projectName }: ExtensionViewProps) {
  const info = useStore((s) => s.extensions.find((e) => e.id === extensionId)) ?? null;
  const setExtensions = useStore((s) => s.setExtensions);
  // FR-38: the selected row of each token-source table, in THIS tab only.
  const [selected, setSelected] = useState<Record<PanelId, TableRow>>({});
  // FR-12: a row selected in one session must never keep driving a sibling
  // panel's token after a session change. Cleared via an effect this would
  // still lag one render behind the session-keyed remount of the log-tail
  // sections below (they key on `sessionId` and mount with THIS render's
  // `selected`, before any effect runs) — so the reset happens synchronously
  // during render instead, using the "adjust state while rendering" pattern:
  // detect the session change against a ref-like piece of state and clear
  // `selected` in the same pass that produces the new children.
  const [selectedForSessionId, setSelectedForSessionId] = useState(sessionId);
  if (selectedForSessionId !== sessionId) {
    setSelectedForSessionId(sessionId);
    setSelected({});
  }

  if (!info) {
    // The list has not landed yet (or no longer carries this extension) — the
    // tab still exists; it simply has nothing to render.
    return <EmptyPane>loading extension…</EmptyPane>;
  }

  const sourcePanelIds = new Set(
    info.panels.map((p) => p.tokenSource?.panelId).filter((id): id is PanelId => typeof id === 'string'),
  );

  const disable = () => {
    void extensionsSetEnabled({ extensionId: info.id, enabled: false, root })
      .then((res) => {
        // FR-8: the store closes the tab, kills the streams and drops the
        // cursors in the same turn as this write.
        if (res.ok) setExtensions(res.data);
      })
      .catch(() => {});
  };

  return (
    <div className="ext-view scz">
      <div className="ext-view__header">
        <span className="ext-view__label">{info.label}</span>
        <span className="ext-view__scope">{root === null ? 'no session' : (projectName ?? root)}</span>
        {/* FR-58: quiet text control, not a destructive button — it is
            reversible from the same modal that lists it. */}
        <span
          role="button"
          tabIndex={0}
          className="ext-view__disable"
          onClick={disable}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              disable();
            }
          }}
          title="turn this extension off"
        >
          {DISABLE_COPY}
        </span>
      </div>

      {info.panels.map((panel) => {
        // FR-12: fleet panels take no root and no session — a session change
        // never touches them. Project panels key on BOTH: the session id so a
        // change between two sessions sharing a root still re-scopes, the root
        // so `panelRoot` stays legible in the key.
        const sectionKey =
          panel.scope === 'fleet' ? `${panel.id}:fleet` : `${panel.id}:${sessionId ?? 'none'}:${panelRoot(panel, root) ?? 'none'}`;
        if (panel.primitive === 'log-tail') {
          const source = panel.tokenSource;
          const token = source ? tokenFromRow(selected[source.panelId], source.rowKey) : null;
          return (
            <LogTailSection
              key={sectionKey}
              extension={info}
              panel={panel}
              root={root}
              sessionId={sessionId}
              detected={info.detected}
              projectName={projectName}
              token={token}
            />
          );
        }
        return (
          <PanelSection
            key={sectionKey}
            extension={info}
            panel={panel}
            root={root}
            sessionId={sessionId}
            detected={info.detected}
            projectName={projectName}
            selectable={sourcePanelIds.has(panel.id)}
            selectedRowId={selected[panel.id]?.id ?? null}
            onSelectRow={(row) => setSelected((prev) => ({ ...prev, [panel.id]: row }))}
            headerAction={panel.action ? <DashboardAction action={panel.action} /> : undefined}
          />
        );
      })}
    </div>
  );
}

// One stacked section of an extension tab (FR-17/FR-18): its own header, its own
// fetch, its own loading / empty / error / not-available / no-session state. A
// slow or failing section never blocks a sibling — each owns its request.
//
// The three PULL primitives live here (`key-value`, `table`, `stat-row`);
// `log-tail` opens a stream instead and has its own component.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EXT_PAGE_SIZE, type ExtensionInfo, type KeyValueRow, type PanelInfo, type TableRow } from '../../../contract/extensions';
import { extensionsPanel } from '../../lib/api';
import { useDelayedFlag } from '../../lib/hooks/useDelayedFlag';
import { useMounted } from '../../lib/hooks/useMounted';
import { EmptyPane } from '../../ui/EmptyPane';
import { LoaderCaret, Orbit } from '../../ui/Loaders';
import ExtSectionError from './ExtSectionError';
import ExtTable from './ExtTable';
import {
  CLOSED_PANEL,
  SELECT_SESSION_COPY,
  effectiveRefreshMs,
  isPanelEmpty,
  nextFetchOffset,
  notAvailableCopy,
  panelRoot,
  receivePanel,
  sanitizeForDisplay,
  sectionGate,
  startPanelFetch,
  toneColor,
  type PanelState,
} from './extensions';
import { StatusDot } from '../../ui/StatusDot';

export interface PanelSectionProps {
  extension: ExtensionInfo;
  panel: PanelInfo;
  /** The active session's root, or null (FR-14). */
  root: string | null;
  /** FR-12: the active session's id, or null — see ExtensionView's sectionKey. */
  sessionId: string | null;
  detected: boolean;
  projectName: string | null;
  /** FR-38: this table feeds a sibling log-tail, so its rows are selectable. */
  selectable: boolean;
  selectedRowId: string | null;
  onSelectRow: (row: TableRow) => void;
}

/** FR-29: auto-refresh stops on window blur and resumes on return. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()));
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return focused;
}

export default function PanelSection({
  extension,
  panel,
  root,
  sessionId,
  detected,
  projectName,
  selectable,
  selectedRowId,
  onSelectRow,
}: PanelSectionProps) {
  const [state, setState] = useState<PanelState>(CLOSED_PANEL);
  const reqRef = useRef(0);
  const inFlight = useRef(false);
  const alive = useMounted();
  const focused = useWindowFocused();
  const gate = sectionGate(panel, { root, detected, token: null });
  const fetchRoot = panelRoot(panel, root);
  // FR-31: the latest cursor, read synchronously — `setState`'s functional
  // updater runs asynchronously, so it can never be the source of the offset
  // an in-flight fetch is about to send; this ref always holds the value the
  // component just rendered with.
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(
    (mode: 'replace' | 'append') => {
      if (inFlight.current) return; // FR-29: a tick never overlaps its own fetch
      const reqId = reqRef.current + 1;
      reqRef.current = reqId;
      inFlight.current = true;
      const offset = nextFetchOffset(stateRef.current.cursor, mode);
      setState((prev) => startPanelFetch(prev, reqId, mode));
      // FR-33: every page is a fresh provider spawn under the identical caps.
      void extensionsPanel({
        panelId: panel.id,
        root: fetchRoot,
        ...(panel.paginated ? { offset, limit: EXT_PAGE_SIZE } : {}),
      })
        .then((res) => {
          inFlight.current = false;
          if (alive.current) setState((prev) => receivePanel(prev, reqId, res));
        })
        .catch(() => {
          inFlight.current = false;
          if (alive.current) {
            setState((prev) =>
              receivePanel(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: 'Could not reach the core' } }),
            );
          }
        });
    },
    // `alive` is a stable ref; the rest is the identity of the request itself.
    [panel.id, panel.paginated, fetchRoot, alive],
  );

  // FR-18/FR-41: the first fetch happens when the tab opens — nothing before it.
  // Re-runs on a root OR session change (FR-12's re-scope — two sessions can
  // share a root, so both are named here even though the parent's `sectionKey`
  // already remounts this component on either and would rerun this effect on
  // its own; `sessionId` is listed explicitly so the rule holds even if the
  // parent's keying strategy ever changes).
  useEffect(() => {
    if (gate !== 'ready') return;
    load('replace');
  }, [gate, load, sessionId]);

  // FR-29: auto-refresh runs only while this tab is the active one (the section
  // is unmounted otherwise) and the window has focus.
  const refreshMs = effectiveRefreshMs(panel);
  useEffect(() => {
    if (gate !== 'ready' || refreshMs === null || !focused) return;
    const id = setInterval(() => load('replace'), refreshMs);
    return () => clearInterval(id);
  }, [gate, refreshMs, focused, load]);

  return (
    <section className="ext-section">
      <div className="ext-section__header">
        <span className="ext-section__label">{sanitizeForDisplay(panel.label)}</span>
        <span className="ext-section__header-right">
          {refreshMs !== null && gate === 'ready' && (
            <span className="ext-section__refresh" title={`refreshes every ${Math.round(refreshMs / 1000)}s`}>
              {/* This is François's own poll ticking, not work it's watching someone
                  else do — Orbit read as a flash on every tick. Back to the pulsing dot. */}
              <StatusDot color="var(--text-muted)" size={5} pulsing={state.status === 'loading'} />
              <span>{Math.round(refreshMs / 1000)}s</span>
            </span>
          )}
        </span>
      </div>
      <div className="ext-section__body">
        <Body
          gate={gate}
          state={state}
          panel={panel}
          extension={extension}
          projectName={projectName}
          selectable={selectable}
          selectedRowId={selectedRowId}
          onSelectRow={onSelectRow}
          onRetry={() => load('replace')}
          onLoadMore={() => load('append')}
        />
      </div>
    </section>
  );
}

function Body({
  gate,
  state,
  panel,
  extension,
  projectName,
  selectable,
  selectedRowId,
  onSelectRow,
  onRetry,
  onLoadMore,
}: {
  gate: ReturnType<typeof sectionGate>;
  state: PanelState;
  panel: PanelInfo;
  extension: ExtensionInfo;
  projectName: string | null;
  selectable: boolean;
  selectedRowId: string | null;
  onSelectRow: (row: TableRow) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  // FR-14 / FR-13: neither is a failure — recessed, never the error tone.
  if (gate === 'no-session') return <div className="ext-note">{SELECT_SESSION_COPY}</div>;
  if (gate === 'unavailable') return <div className="ext-note ext-note--recessed">{notAvailableCopy(projectName)}</div>;

  if (state.status === 'error' && state.error) {
    return <ExtSectionError error={state.error} minVersionLabel={extension.minVersionLabel} onRetry={onRetry} />;
  }

  // FR-18: several sections can load at once, so a pane-owning Slabs would be
  // wrong here — an inline caret naming the section instead.
  if (state.status === 'idle' || (state.status === 'loading' && isBlank(state, panel))) {
    return <LoaderCaret label={`loading ${sanitizeForDisplay(panel.label)}`} />;
  }

  // FR-49: a validated zero-row payload is a SUCCESS with its own calm copy.
  if (isPanelEmpty(state, panel.primitive))
    return <EmptyPane className="ext-empty">{sanitizeForDisplay(panel.emptyCopy)}</EmptyPane>;

  if (panel.primitive === 'key-value') {
    return (
      <div className="ext-kv">
        {state.keyValue.map((row, i) => (
          <KvRow key={`${row.key}:${i}`} row={row} />
        ))}
      </div>
    );
  }

  if (panel.primitive === 'stat-row') {
    return (
      <div className="ext-stats">
        {state.tiles.map((tile, i) => (
          <div className="ext-stat" key={`${tile.label}:${i}`}>
            <span className="ext-stat__label">{tile.label}</span>
            <span className="ext-stat__value">{tile.value}</span>
            {tile.sublabel && <span className="ext-stat__sublabel">{tile.sublabel}</span>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <ExtTable
      columns={panel.columns ?? []}
      cursor={state.cursor}
      paginated={panel.paginated}
      loading={state.status === 'loading'}
      selectable={selectable}
      selectedRowId={selectedRowId}
      onSelectRow={onSelectRow}
      onLoadMore={onLoadMore}
    />
  );
}

/**
 * One `key-value` row. A `busy` tone means the PROVIDER (an out-of-process
 * extension, not François's own poll) is still working on that value — Orbit
 * fits, but only once the wait clears 300ms, so a value that resolves fast
 * never flashes it.
 */
function KvRow({ row }: { row: KeyValueRow }) {
  const busy = row.tone === 'busy';
  const showOrbit = useDelayedFlag(busy, 300);
  return (
    <div className="ext-kv__row">
      <span className="ext-kv__status-slot">
        {/* Under 300ms a busy row still reads as busy — its own colour, just not
            yet animated — rather than flashing a spinner or leaving the slot blank. */}
        {showOrbit ? <Orbit size={14} label={null} /> : <StatusDot color={toneColor(row.tone)} size={busy ? 8 : 6} />}
      </span>
      <span className="ext-kv__key">{row.key}</span>
      <span className="ext-kv__value">{row.value}</span>
    </div>
  );
}

function isBlank(state: PanelState, panel: PanelInfo): boolean {
  if (panel.primitive === 'table') return state.cursor.rows.length === 0;
  if (panel.primitive === 'key-value') return state.keyValue.length === 0;
  return state.tiles.length === 0;
}

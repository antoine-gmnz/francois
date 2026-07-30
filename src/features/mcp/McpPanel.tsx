import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, McpServerInfo, SessionEvent } from '../../../contract/common';
import type { McpRegistryEntry, McpServerDetail } from '../../../contract/mcp-panel';
import { mcpDetach, mcpDetail, mcpList, mcpReconnect, onSessionEvent } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { HintBar } from '../../ui/HintBar';
import { StatusDot } from '../../ui/StatusDot';
import { detailText, dotColor, scopeColor, scopeText } from './mcp';
import { useAttachFlow } from './useAttachFlow';
import { RegistryStep } from './RegistryStep';
import { ParamsStep } from './ParamsStep';
import './mcp.css';

// ---------- server list hook ----------

function useMcpServers(sessionId: string | null) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [listError, setListError] = useState<AppError | null>(null);

  // Hydration + live mcp.update (FR-1/2/3/28).
  useEffect(() => {
    setServers([]);
    setListError(null);
    if (!sessionId) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;

    void onSessionEvent((e: SessionEvent) => {
      if (e.type !== 'mcp.update' || e.sessionId !== sessionId) return;
      setServers((prev) => {
        const i = prev.findIndex((server) => server.name === e.server.name);
        if (i === -1) return [...prev, e.server];
        const next = prev.slice();
        // runtime updates don't carry scope — keep the one mcp_list resolved.
        next[i] = { ...e.server, scope: e.server.scope ?? prev[i].scope };
        return next;
      });
    }).then((unsub) => {
      if (!mounted) unsub();
      else unlisten = unsub;
    });

    void mcpList(sessionId).then((res) => {
      if (!mounted) return; // FR-28
      if (res.ok) setServers(res.data);
      else setListError(res.error);
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  return { servers, setServers, listError };
}

export default function McpPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  // attach overlay lives in the store so the command palette can open it too (FR-23)
  const attachOpen = useStore((s) => s.mcpAttachOpen);
  const setAttachOpen = useStore((s) => s.setMcpAttachOpen);

  const { servers, setServers, listError } = useMcpServers(sessionId);
  const [selected, setSelected] = useState(0);
  const [popover, setPopover] = useState<{ name: string; top: number; left: number } | null>(null);
  const focused = focusedPane === 'mcp';
  const rowsRef = useRef<HTMLDivElement>(null);
  const existingNames = useMemo(() => servers.map((server) => server.name), [servers]);

  // Reset the panel's own selection/overlay state on session switch (servers/listError reset inside useMcpServers).
  useEffect(() => {
    setSelected(0);
    setPopover(null);
    setAttachOpen(false);
  }, [sessionId, setAttachOpen]);

  const openDetail = (index: number) => {
    const server = servers[index];
    if (!server) return;
    setSelected(index);
    const rows = rowsRef.current;
    const rowEls = rows?.querySelectorAll('[data-mcp-row]');
    const el = rowEls?.[index] as HTMLElement | undefined;
    const r = el?.getBoundingClientRect();
    const top = r ? Math.min(r.top, window.innerHeight - 240) : 120;
    const left = r ? Math.max(8, r.left - 288) : 8; // open to the left of the column
    setPopover({ name: server.name, top, left });
  };

  // Keyboard for pane [4] (FR-7/8/15).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (attachOpen) return;
      if (popover) {
        if (e.key === 'Escape') {
          setPopover(null);
        }
        return;
      }
      if (!focused) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, servers.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (servers[selected]) {
          e.preventDefault();
          openDetail(selected);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, attachOpen, popover, servers, selected]);

  return (
    <section onClick={() => setFocusedPane('mcp')} className={focused ? 'mcp-panel mcp-panel--focused' : 'mcp-panel'}>
      <div className="mcp-header">
        <span className={focused ? 'mcp-header-title mcp-header-title--focused' : 'mcp-header-title'}>MCP SERVERS</span>
        <div className="mcp-header-right">
          <span className="mcp-header-count">{servers.length} · [4]</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (sessionId) setAttachOpen(true);
            }}
            title="attach MCP server"
            className={sessionId ? 'mcp-attach-btn' : 'mcp-attach-btn mcp-attach-btn--disabled'}
          >
            +
          </span>
        </div>
      </div>

      <div ref={rowsRef} className="scz mcp-rows">
        {listError ? (
          <div className="mcp-list-error">session unavailable</div>
        ) : servers.length === 0 ? (
          <div className="mcp-empty">no MCP servers · attach one with ⌘K</div>
        ) : (
          servers.map((server, i) => (
            <ServerRow
              key={server.name}
              server={server}
              selected={i === selected}
              onClick={() => {
                setFocusedPane('mcp');
                openDetail(i);
              }}
            />
          ))
        )}
      </div>

      {popover && sessionId && (
        <DetailPopover
          sessionId={sessionId}
          name={popover.name}
          top={popover.top}
          left={popover.left}
          onClose={() => setPopover(null)}
          onReconnected={(name) =>
            setServers((prev) =>
              prev.map((server) => (server.name === name ? { ...server, status: 'connecting', toolCount: undefined, errorMessage: undefined } : server)),
            )
          }
          onDetached={(name) => {
            setServers((prev) => prev.filter((server) => server.name !== name));
            setPopover(null);
          }}
        />
      )}

      {attachOpen && sessionId && (
        <AttachOverlay sessionId={sessionId} existing={existingNames} onClose={() => setAttachOpen(false)} />
      )}
    </section>
  );
}

// ---------- server row ----------

function ServerRow({ server, selected, onClick }: { server: McpServerInfo; selected: boolean; onClick: () => void }) {
  const detail = detailText(server);
  return (
    <div data-mcp-row onClick={(e) => { e.stopPropagation(); onClick(); }} className={selected ? 'mcp-row mcp-row--selected' : 'mcp-row'}>
      <StatusDot color={dotColor(server.status)} pulsing={server.status === 'connecting'} />
      <span className="mcp-row-name truncate">{server.name}</span>
      {server.scope && (
        <span className="mcp-scope-badge" style={{ color: scopeColor(server.scope) }}>
          {server.scope}
        </span>
      )}
      <span className="mcp-row-detail" style={{ color: detail.color }}>
        {detail.text}
      </span>
    </div>
  );
}

// ---------- detail popover ----------

function useMcpDetail(sessionId: string, name: string) {
  const [data, setData] = useState<McpServerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    let mounted = true;
    void mcpDetail(sessionId, name).then((res) => {
      if (!mounted) return;
      setLoading(false);
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId, name]);

  return { data, loading, error };
}

function DetailPopover({
  sessionId,
  name,
  top,
  left,
  onClose,
  onReconnected,
  onDetached,
}: {
  sessionId: string;
  name: string;
  top: number;
  left: number;
  onClose: () => void;
  onReconnected: (name: string) => void;
  onDetached: (name: string) => void;
}) {
  const { data, loading, error } = useMcpDetail(sessionId, name);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, { onOutsideClick: onClose });

  const reconnect = async () => {
    setActionError(null);
    const res = await mcpReconnect(sessionId, name);
    if (res.ok) {
      onReconnected(name);
      onClose();
    } else setActionError(res.error);
  };

  const detach = async () => {
    setActionError(null);
    const res = await mcpDetach(sessionId, name);
    if (res.ok) onDetached(name);
    else {
      setConfirming(false);
      setActionError(res.error);
    }
  };

  const status = data?.status ?? 'connecting';

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} className="mcp-popover" style={{ top, left }}>
      <div className="mcp-popover-header">
        <StatusDot color={dotColor(status)} />
        <span className="mcp-popover-name">{name}</span>
        <span className="mcp-popover-status" style={{ color: dotColor(status) }}>
          {status}
        </span>
      </div>

      <div className="mcp-popover-body">
        {loading ? (
          <span className="mcp-popover-loading">loading…</span>
        ) : error ? (
          <span className="mcp-popover-error">{error.message}</span>
        ) : data ? (
          <>
            <Field label="TRANSPORT" value={data.transport} />
            {data.scope && <Field label="SCOPE" value={scopeText(data.scope)} />}
            {data.transport === 'stdio' && data.command && <Field label="COMMAND" value={data.command} mono />}
            {data.transport === 'http' && data.url && <Field label="URL" value={data.url} mono />}
            {data.status === 'connected' && <Field label="TOOLS" value={String(data.toolCount ?? 0)} />}
            {data.status === 'error' && data.errorMessage && <Field label="ERROR" value={data.errorMessage} color="var(--error)" />}
          </>
        ) : null}

        {actionError && <span className="mcp-popover-action-error">{actionError.message}</span>}
      </div>

      {data && (
        <div className="mcp-popover-footer">
          {confirming ? (
            <>
              <span className="mcp-popover-confirm-text">detach '{name}' from .mcp.json?</span>
              <span onClick={() => setConfirming(false)} className="mcp-action-link mcp-action-link--dim">
                Cancel
              </span>
              <span onClick={() => void detach()} className="mcp-action-link mcp-action-link--error">
                Confirm
              </span>
            </>
          ) : (
            <>
              <span onClick={() => void reconnect()} className="mcp-action-link">
                Reconnect
              </span>
              {(!data.scope || data.scope === 'project') && (
                <span onClick={() => setConfirming(true)} className="mcp-action-link">
                  Detach
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div>
      <div className="mcp-detail-label">{label}</div>
      <div className={mono ? 'mcp-detail-value mcp-detail-value--mono' : 'mcp-detail-value'} style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

// ---------- attach overlay ----------

const REGISTRY_HINTS = [
  { key: '↑↓', label: 'navigate' },
  { key: '⏎', label: 'select' },
  { key: 'esc', label: 'dismiss' },
];
const PARAMS_HINTS = [
  { key: '⏎', label: 'submit' },
  { key: 'esc', label: 'back' },
];

function AttachOverlay({ sessionId, existing, onClose }: { sessionId: string; existing: string[]; onClose: () => void }) {
  const flow = useAttachFlow(sessionId, existing, onClose);
  const { step, rows, regError, selIndex, setSelIndex, selected, advance, form, setForm, custom, setCustom, submitting, submitError, canSubmit, submit } =
    flow;

  return (
    <div onClick={onClose} className="mcp-overlay-backdrop">
      <div onClick={(e) => e.stopPropagation()} className="mcp-overlay-panel">
        <div className="mcp-overlay-header">
          <span className="mcp-overlay-icon">⊞</span>
          <span className="mcp-overlay-title">
            {step === 'registry' ? 'attach MCP server' : selected === 'custom' ? 'custom server' : `configure ${(selected as McpRegistryEntry).name}`}
          </span>
          <span className="mcp-overlay-esc">esc</span>
        </div>

        {step === 'registry' ? (
          <RegistryStep rows={rows} regError={regError} selIndex={selIndex} onHover={setSelIndex} onSelect={advance} />
        ) : (
          <ParamsStep
            selected={selected as McpRegistryEntry | 'custom'}
            custom={custom}
            onCustomChange={setCustom}
            form={form}
            onFormChange={setForm}
            submitError={submitError}
            canSubmit={canSubmit}
            submitting={submitting}
            onSubmit={submit}
          />
        )}

        <HintBar items={step === 'registry' ? REGISTRY_HINTS : PARAMS_HINTS} />
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, McpServerInfo, SessionEvent } from '../contract/common';
import type { McpRegistryEntry, McpServerDetail, McpAttachRequest } from '../contract/mcp-panel';
import { mcpAttach, mcpDetach, mcpDetail, mcpList, mcpReconnect, mcpRegistry, onSessionEvent } from './api';
import { useStore } from './store';

const C = {
  connected: '#7fa07a',
  connecting: '#c2b06a',
  error: '#c46b62',
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
  hint: '#a9adb6',
};

const dotColor: Record<string, string> = {
  connected: C.connected,
  connecting: C.connecting,
  error: C.error,
};

const scopeColor: Record<string, string> = {
  project: '#8a8f9a',
  local: '#7c8aa0',
  user: '#6b7079',
};

const scopeText = (scope: string): string =>
  scope === 'project'
    ? 'project · .mcp.json'
    : scope === 'local'
      ? 'local · ~/.claude.json'
      : scope === 'user'
        ? 'user · global'
        : scope;

function scopeBadge(scope: string): React.CSSProperties {
  return {
    fontSize: 8.5,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: scopeColor[scope] ?? C.faint,
    border: '1px solid #2a2c33',
    borderRadius: 3,
    padding: '1px 4px',
    flexShrink: 0,
    lineHeight: 1.4,
  };
}

function detailText(s: McpServerInfo): { text: string; color: string } {
  if (s.status === 'connected') return { text: `${s.toolCount ?? 0} tools`, color: C.dim };
  if (s.status === 'connecting') return { text: 'handshake…', color: C.dim };
  return { text: s.errorMessage ?? 'error', color: C.error };
}

export default function McpPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  // attach overlay lives in the store so the command palette can open it too (FR-23)
  const attachOpen = useStore((s) => s.mcpAttachOpen);
  const setAttachOpen = useStore((s) => s.setMcpAttachOpen);

  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [listError, setListError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState(0);
  const [popover, setPopover] = useState<{ name: string; top: number; left: number } | null>(null);
  const focused = focusedPane === 'mcp';
  const rowsRef = useRef<HTMLDivElement>(null);
  const existingNames = useMemo(() => servers.map((s) => s.name), [servers]);

  // Hydration + live mcp.update (FR-1/2/3/28). Keyed by sessionId in App.
  useEffect(() => {
    setServers([]);
    setListError(null);
    setSelected(0);
    setPopover(null);
    setAttachOpen(false);
    if (!sessionId) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;

    void onSessionEvent((e: SessionEvent) => {
      if (e.type !== 'mcp.update' || e.sessionId !== sessionId) return;
      setServers((prev) => {
        const i = prev.findIndex((s) => s.name === e.server.name);
        if (i === -1) return [...prev, e.server];
        const next = prev.slice();
        // runtime updates don't carry scope — keep the one mcp_list resolved.
        next[i] = { ...e.server, scope: e.server.scope ?? prev[i].scope };
        return next;
      });
    }).then((u) => {
      if (!mounted) u();
      else unlisten = u;
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

  const openDetail = (index: number) => {
    const s = servers[index];
    if (!s) return;
    setSelected(index);
    const rows = rowsRef.current;
    const rowEls = rows?.querySelectorAll('[data-mcp-row]');
    const el = rowEls?.[index] as HTMLElement | undefined;
    const r = el?.getBoundingClientRect();
    const top = r ? Math.min(r.top, window.innerHeight - 240) : 120;
    const left = r ? Math.max(8, r.left - 288) : 8; // open to the left of the column
    setPopover({ name: s.name, top, left });
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
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
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
    <section
      onClick={() => setFocusedPane('mcp')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#16171c',
        border: `1px solid ${focused ? C.accent : '#2a2c33'}`,
        borderRadius: 5,
        overflow: 'hidden',
        minHeight: 0,
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid #24262d',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          MCP SERVERS
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: C.faint }}>{servers.length} · [4]</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (sessionId) setAttachOpen(true);
            }}
            title="attach MCP server"
            style={{ fontSize: 12, color: C.faint, cursor: sessionId ? 'pointer' : 'default', lineHeight: 1 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.faint)}
          >
            +
          </span>
        </div>
      </div>

      <div ref={rowsRef} className="scz" style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {listError ? (
          <div style={{ padding: '12px 4px', fontSize: 11, color: C.error }}>session unavailable</div>
        ) : servers.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: C.faint, textAlign: 'center' }}>
            no MCP servers · attach one with ⌘K
          </div>
        ) : (
          servers.map((s, i) => {
            const d = detailText(s);
            const sel = i === selected;
            return (
              <div
                key={s.name}
                data-mcp-row
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusedPane('mcp');
                  openDetail(i);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '7px 6px',
                  borderBottom: '1px solid #1d1f25',
                  background: sel ? '#20222a' : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 120ms ease',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: dotColor[s.status] ?? C.dim,
                    animation: s.status === 'connecting' ? 'pulse 1.4s ease-in-out infinite' : 'none',
                  }}
                />
                <span style={{ fontSize: 12, color: C.primary, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name}
                </span>
                {s.scope && <span style={scopeBadge(s.scope)}>{s.scope}</span>}
                <span style={{ fontSize: 10.5, color: d.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
                  {d.text}
                </span>
              </div>
            );
          })
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
            setServers((prev) => prev.map((s) => (s.name === name ? { ...s, status: 'connecting', toolCount: undefined, errorMessage: undefined } : s)))
          }
          onDetached={(name) => {
            setServers((prev) => prev.filter((s) => s.name !== name));
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

// ---------- detail popover ----------

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
  const [data, setData] = useState<McpServerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

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
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top,
        left,
        width: 280,
        background: '#191b21',
        border: '1px solid #34363f',
        borderRadius: 6,
        boxShadow: '0 20px 50px -15px rgba(0,0,0,0.75)',
        zIndex: 40,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '11px 13px', borderBottom: '1px solid #24262d', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor[status] ?? C.dim }} />
        <span style={{ fontSize: 13, color: C.bright, flex: 1 }}>{name}</span>
        <span style={{ fontSize: 10, color: dotColor[status] ?? C.dim }}>{status}</span>
      </div>

      <div style={{ padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {loading ? (
          <span style={{ fontSize: 11, color: C.faint }}>loading…</span>
        ) : error ? (
          <span style={{ fontSize: 11, color: C.error }}>{error.message}</span>
        ) : data ? (
          <>
            <Field label="TRANSPORT" value={data.transport} />
            {data.scope && <Field label="SCOPE" value={scopeText(data.scope)} />}
            {data.transport === 'stdio' && data.command && <Field label="COMMAND" value={data.command} mono />}
            {data.transport === 'http' && data.url && <Field label="URL" value={data.url} mono />}
            {data.status === 'connected' && <Field label="TOOLS" value={String(data.toolCount ?? 0)} />}
            {data.status === 'error' && data.errorMessage && <Field label="ERROR" value={data.errorMessage} color={C.error} />}
          </>
        ) : null}

        {actionError && <span style={{ fontSize: 10.5, color: C.error }}>{actionError.message}</span>}
      </div>

      {data && (
        <div style={{ padding: '9px 13px', borderTop: '1px solid #24262d', display: 'flex', gap: 14, justifyContent: 'flex-end' }}>
          {confirming ? (
            <>
              <span style={{ fontSize: 10.5, color: C.faint, flex: 1 }}>detach '{name}' from .mcp.json?</span>
              <span onClick={() => setConfirming(false)} style={{ fontSize: 11, color: C.dim, cursor: 'pointer' }}>
                Cancel
              </span>
              <span onClick={() => void detach()} style={{ fontSize: 11, color: C.error, cursor: 'pointer' }}>
                Confirm
              </span>
            </>
          ) : (
            <>
              <span onClick={() => void reconnect()} style={btnStyle}>
                Reconnect
              </span>
              {(!data.scope || data.scope === 'project') && (
                <span onClick={() => setConfirming(true)} style={btnStyle}>
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

const btnStyle: React.CSSProperties = { fontSize: 11, color: '#a9adb6', cursor: 'pointer' };

function Field({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.faint, letterSpacing: '0.06em' }}>{label}</div>
      <div
        style={{
          fontSize: 12,
          color: color ?? C.primary,
          marginTop: 2,
          fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---------- attach overlay ----------

function AttachOverlay({ sessionId, existing, onClose }: { sessionId: string; existing: string[]; onClose: () => void }) {
  const [step, setStep] = useState<'registry' | 'params'>('registry');
  const [registry, setRegistry] = useState<McpRegistryEntry[] | null>(null);
  const [regError, setRegError] = useState<AppError | null>(null);
  const [selIndex, setSelIndex] = useState(0);
  const [selected, setSelected] = useState<McpRegistryEntry | 'custom' | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<{ name: string; transport: 'stdio' | 'http'; command: string; url: string }>({
    name: '',
    transport: 'stdio',
    command: '',
    url: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);

  useEffect(() => {
    void mcpRegistry().then((res) => {
      if (res.ok) setRegistry(res.data);
      else setRegError(res.error);
    });
  }, []);

  const rows: (McpRegistryEntry | 'custom')[] = [...(registry ?? []), 'custom'];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (step === 'params') setStep('registry');
        else onClose();
      } else if (step === 'registry') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelIndex((i) => Math.min(i + 1, rows.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          advance(rows[selIndex]);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const advance = (row: McpRegistryEntry | 'custom') => {
    setSelected(row);
    setForm({});
    setSubmitError(null);
    setStep('params');
  };

  const submit = async () => {
    if (submitting || !selected) return;
    let req: McpAttachRequest;
    if (selected === 'custom') {
      const name = custom.name.trim();
      if (!name || existing.includes(name)) {
        setSubmitError({ code: 'INVALID_INPUT', message: existing.includes(name) ? 'name already exists' : 'name required' });
        return;
      }
      req = {
        name,
        transport: custom.transport,
        command: custom.transport === 'stdio' ? custom.command.trim() : undefined,
        url: custom.transport === 'http' ? custom.url.trim() : undefined,
      };
    } else {
      const entry = selected;
      if (existing.includes(entry.name)) {
        setSubmitError({ code: 'INVALID_INPUT', message: 'name already exists' });
        return;
      }
      const secretParams: Record<string, string> = {};
      let command = entry.commandTemplate ?? '';
      let url = entry.urlTemplate ?? '';
      for (const p of entry.params) {
        const val = form[p.key] ?? '';
        if (p.secret) secretParams[p.key] = val;
        else {
          const token = `{${p.key}}`;
          command = command.split(token).join(val);
          url = url.split(token).join(val);
        }
      }
      req = {
        name: entry.name,
        transport: entry.transport,
        command: entry.transport === 'stdio' ? command : undefined,
        url: entry.transport === 'http' ? url : undefined,
        secretParams: Object.keys(secretParams).length ? secretParams : undefined,
        registrySource: entry.name,
      };
    }
    setSubmitting(true);
    setSubmitError(null);
    const res = await mcpAttach(sessionId, req);
    setSubmitting(false);
    if (res.ok) onClose();
    else setSubmitError(res.error);
  };

  // submit-enabled gating
  const canSubmit = (() => {
    if (!selected) return false;
    if (selected === 'custom') {
      const nameOk = custom.name.trim() !== '' && !existing.includes(custom.name.trim());
      return nameOk && (custom.transport === 'stdio' ? custom.command.trim() !== '' : custom.url.trim() !== '');
    }
    return selected.params.every((p) => !p.required || (form[p.key] ?? '').trim() !== '') && !existing.includes(selected.name);
  })();

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(6,7,9,0.62)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 118, zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 588, background: '#191b21', border: '1px solid #34363f', borderRadius: 8, overflow: 'hidden', boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', borderBottom: '1px solid #24262d' }}>
          <span style={{ color: C.accent, fontSize: 15 }}>⊞</span>
          <span style={{ fontSize: 14, color: '#d3d6dc', flex: 1 }}>
            {step === 'registry' ? 'attach MCP server' : selected === 'custom' ? 'custom server' : `configure ${(selected as McpRegistryEntry).name}`}
          </span>
          <span style={{ fontSize: 10, color: C.faint }}>esc</span>
        </div>

        {step === 'registry' ? (
          <div style={{ padding: 6 }}>
            {regError && <div style={{ padding: '6px 12px', fontSize: 10.5, color: C.error }}>{regError.message} — custom still available</div>}
            {rows.map((row, i) => {
              const isCustom = row === 'custom';
              const sel = i === selIndex;
              return (
                <div
                  key={isCustom ? 'custom' : row.name}
                  onMouseEnter={() => setSelIndex(i)}
                  onClick={() => advance(row)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 5, background: sel ? '#26282f' : 'transparent', cursor: 'pointer' }}
                >
                  <span style={{ width: 16, textAlign: 'center', fontSize: 12, color: sel ? C.accent : C.dim }}>{isCustom ? '+' : '⊞'}</span>
                  <span style={{ fontSize: 13, color: sel ? C.bright : C.primary, flexShrink: 0 }}>{isCustom ? 'custom…' : row.name}</span>
                  <span style={{ fontSize: 11, color: C.faint, flex: 1, textAlign: 'right' }}>{isCustom ? 'define manually' : row.description}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {selected === 'custom' ? (
              <>
                <FormField label="NAME" required value={custom.name} onChange={(v) => setCustom({ ...custom, name: v })} />
                <div>
                  <div style={fieldLabel}>TRANSPORT</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                    {(['stdio', 'http'] as const).map((t) => (
                      <span key={t} onClick={() => setCustom({ ...custom, transport: t })} style={pill(custom.transport === t)}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                {custom.transport === 'stdio' ? (
                  <FormField label="COMMAND" required mono value={custom.command} onChange={(v) => setCustom({ ...custom, command: v })} />
                ) : (
                  <FormField label="URL" required mono value={custom.url} onChange={(v) => setCustom({ ...custom, url: v })} />
                )}
              </>
            ) : (
              (selected as McpRegistryEntry).params.map((p) => (
                <FormField
                  key={p.key}
                  label={p.label}
                  required={p.required}
                  secret={p.secret}
                  value={form[p.key] ?? ''}
                  onChange={(v) => setForm({ ...form, [p.key]: v })}
                />
              ))
            )}

            {submitError && (
              <div style={{ background: 'rgba(196,107,98,0.09)', color: C.error, fontSize: 11, borderRadius: 4, padding: '8px 10px' }}>
                {submitError.message}
              </div>
            )}

            <button onClick={submit} disabled={!canSubmit || submitting} style={submitStyle(canSubmit && !submitting)}>
              {submitting ? 'attaching…' : 'Attach server'}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, padding: '9px 16px', borderTop: '1px solid #24262d', fontSize: 10, color: C.faint }}>
          {step === 'registry' ? (
            <>
              <span>
                <span style={{ color: C.dim }}>↑↓</span> navigate
              </span>
              <span>
                <span style={{ color: C.dim }}>⏎</span> select
              </span>
              <span>
                <span style={{ color: C.dim }}>esc</span> dismiss
              </span>
            </>
          ) : (
            <>
              <span>
                <span style={{ color: C.dim }}>⏎</span> submit
              </span>
              <span>
                <span style={{ color: C.dim }}>esc</span> back
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = { fontSize: 11, color: C.dim };

function FormField({
  label,
  value,
  onChange,
  required,
  secret,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  secret?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <div style={fieldLabel}>
        {label}
        {required && <span style={{ color: C.accent }}> *</span>}
      </div>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          marginTop: 5,
          width: '100%',
          background: '#16171c',
          border: '1px solid #24262d',
          borderRadius: 4,
          height: 32,
          color: C.primary,
          fontSize: 12.5,
          fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
          padding: '0 10px',
          outline: 'none',
        }}
      />
    </div>
  );
}

function pill(sel: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    border: `1px solid ${sel ? C.accent : '#2a2c33'}`,
    background: sel ? 'rgba(200,161,90,0.12)' : '#16171c',
    color: sel ? C.accent : C.dim,
  };
}

function submitStyle(enabled: boolean): React.CSSProperties {
  return {
    marginTop: 4,
    width: '100%',
    height: 34,
    border: 'none',
    borderRadius: 5,
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: enabled ? 'pointer' : 'default',
    background: enabled ? '#26282f' : '#1b1d23',
    color: enabled ? C.accent : C.faint,
  };
}

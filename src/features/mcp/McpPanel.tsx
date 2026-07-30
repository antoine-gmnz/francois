import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, McpServerInfo, SessionEvent } from '../../../contract/common';
import type { McpRegistryEntry, McpServerDetail } from '../../../contract/mcp-panel';
import { mcpAttach, mcpDetach, mcpDetail, mcpList, mcpReconnect, mcpRegistry, onSessionEvent } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { HintBar } from '../../ui/HintBar';
import { StatusDot } from '../../ui/StatusDot';
import {
  buildAttachRequest,
  canSubmitAttach,
  detailText,
  dotColor,
  scopeColor,
  scopeText,
  type CustomServerForm,
} from './mcp';
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
  const existingNames = useMemo(() => servers.map((s) => s.name), [servers]);

  // Reset the panel's own selection/overlay state on session switch (servers/listError reset inside useMcpServers).
  useEffect(() => {
    setSelected(0);
    setPopover(null);
    setAttachOpen(false);
  }, [sessionId, setAttachOpen]);

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
          servers.map((s, i) => (
            <ServerRow
              key={s.name}
              server={s}
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

function useAttachFlow(sessionId: string, existing: string[], onClose: () => void) {
  const [step, setStep] = useState<'registry' | 'params'>('registry');
  const [registry, setRegistry] = useState<McpRegistryEntry[] | null>(null);
  const [regError, setRegError] = useState<AppError | null>(null);
  const [selIndex, setSelIndex] = useState(0);
  const [selected, setSelected] = useState<McpRegistryEntry | 'custom' | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<CustomServerForm>({ name: '', transport: 'stdio', command: '', url: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);

  useEffect(() => {
    void mcpRegistry().then((res) => {
      if (res.ok) setRegistry(res.data);
      else setRegError(res.error);
    });
  }, []);

  const rows: (McpRegistryEntry | 'custom')[] = [...(registry ?? []), 'custom'];

  const advance = (row: McpRegistryEntry | 'custom') => {
    setSelected(row);
    setForm({});
    setSubmitError(null);
    setStep('params');
  };

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

  const submit = async () => {
    if (submitting || !selected) return;
    const result = buildAttachRequest(selected, custom, form, existing);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const res = await mcpAttach(sessionId, result.request);
    setSubmitting(false);
    if (res.ok) onClose();
    else setSubmitError(res.error);
  };

  const canSubmit = canSubmitAttach(selected, custom, form, existing);

  return {
    step,
    rows,
    regError,
    selIndex,
    setSelIndex,
    selected,
    advance,
    form,
    setForm,
    custom,
    setCustom,
    submitting,
    submitError,
    canSubmit,
    submit,
  };
}

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

function RegistryStep({
  rows,
  regError,
  selIndex,
  onHover,
  onSelect,
}: {
  rows: (McpRegistryEntry | 'custom')[];
  regError: AppError | null;
  selIndex: number;
  onHover: (i: number) => void;
  onSelect: (row: McpRegistryEntry | 'custom') => void;
}) {
  return (
    <div className="mcp-registry-list">
      {regError && <div className="mcp-registry-error">{regError.message} — custom still available</div>}
      {rows.map((row, i) => (
        <RegistryRow key={row === 'custom' ? 'custom' : row.name} row={row} selected={i === selIndex} onMouseEnter={() => onHover(i)} onClick={() => onSelect(row)} />
      ))}
    </div>
  );
}

function RegistryRow({
  row,
  selected,
  onMouseEnter,
  onClick,
}: {
  row: McpRegistryEntry | 'custom';
  selected: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const isCustom = row === 'custom';
  return (
    <div onMouseEnter={onMouseEnter} onClick={onClick} className={selected ? 'mcp-registry-row mcp-registry-row--selected' : 'mcp-registry-row'}>
      <span className={selected ? 'mcp-registry-glyph mcp-registry-glyph--selected' : 'mcp-registry-glyph'}>{isCustom ? '+' : '⊞'}</span>
      <span className={selected ? 'mcp-registry-name mcp-registry-name--selected' : 'mcp-registry-name'}>{isCustom ? 'custom…' : row.name}</span>
      <span className="mcp-registry-desc">{isCustom ? 'define manually' : row.description}</span>
    </div>
  );
}

function ParamsStep({
  selected,
  custom,
  onCustomChange,
  form,
  onFormChange,
  submitError,
  canSubmit,
  submitting,
  onSubmit,
}: {
  selected: McpRegistryEntry | 'custom';
  custom: CustomServerForm;
  onCustomChange: (next: CustomServerForm) => void;
  form: Record<string, string>;
  onFormChange: (next: Record<string, string>) => void;
  submitError: AppError | null;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="mcp-params-step">
      {selected === 'custom' ? (
        <CustomServerFields custom={custom} onChange={onCustomChange} />
      ) : (
        <TemplateParamFields entry={selected} form={form} onChange={onFormChange} />
      )}

      {submitError && <div className="form-error">{submitError.message}</div>}

      <button onClick={onSubmit} disabled={!canSubmit || submitting} className={canSubmit && !submitting ? 'mcp-submit-btn mcp-submit-btn--enabled' : 'mcp-submit-btn'}>
        {submitting ? 'attaching…' : 'Attach server'}
      </button>
    </div>
  );
}

function CustomServerFields({ custom, onChange }: { custom: CustomServerForm; onChange: (next: CustomServerForm) => void }) {
  return (
    <>
      <FormField label="NAME" required value={custom.name} onChange={(v) => onChange({ ...custom, name: v })} />
      <div>
        <div className="mcp-form-label">TRANSPORT</div>
        <div className="mcp-transport-pills">
          {(['stdio', 'http'] as const).map((t) => (
            <span key={t} onClick={() => onChange({ ...custom, transport: t })} className={custom.transport === t ? 'mcp-pill mcp-pill--selected' : 'mcp-pill'}>
              {t}
            </span>
          ))}
        </div>
      </div>
      {custom.transport === 'stdio' ? (
        <FormField label="COMMAND" required mono value={custom.command} onChange={(v) => onChange({ ...custom, command: v })} />
      ) : (
        <FormField label="URL" required mono value={custom.url} onChange={(v) => onChange({ ...custom, url: v })} />
      )}
    </>
  );
}

function TemplateParamFields({
  entry,
  form,
  onChange,
}: {
  entry: McpRegistryEntry;
  form: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <>
      {entry.params.map((p) => (
        <FormField key={p.key} label={p.label} required={p.required} secret={p.secret} value={form[p.key] ?? ''} onChange={(v) => onChange({ ...form, [p.key]: v })} />
      ))}
    </>
  );
}

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
      <div className="mcp-form-label">
        {label}
        {required && <span className="mcp-form-required"> *</span>}
      </div>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? 'mcp-form-input mcp-form-input--mono' : 'mcp-form-input'}
      />
    </div>
  );
}

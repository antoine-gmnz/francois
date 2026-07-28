// plugin-system §8·C — the FRANCOIS PLUGINS modal.
//
// The word FRANCOIS in the title is load-bearing (§8·C6): it is what separates
// this from the Claude Code plugins `skills-panel` already surfaces. The two
// never touch — installing here writes nothing to `~/.claude/` (FR-8).
//
// The consent card is the only path to an install, and it is the one screen in
// Francois whose job is to be read rather than skimmed. It states the source and
// its pin, every capability in plain language, every host verbatim, and — when
// both readState and network are granted — the standing warning that those two
// together are an exfiltration channel (§8·C4 / FR-11).

import { useEffect, useMemo, useState } from 'react';
import type {
  InstalledPlugin,
  PluginCapabilities,
  PluginEnablement,
  PluginSettingDescriptor,
} from '../../../contract/plugin-system';
import { SECRET_SENTINEL } from '../../../contract/plugin-system';
import {
  pluginsCheckUpdate,
  pluginsInstall,
  pluginsResolve,
  pluginsSetEnablement,
  pluginsSetSettings,
  pluginsUninstall,
  pluginsUpdate,
} from '../../lib/api';
import { useStore } from '../../lib/store';
import { usePluginsStore } from './pluginsStore';
import {
  EXFILTRATION_WARNING,
  SECRETS_NOTE,
  SECRET_PLACEHOLDER,
  capabilityRows,
  isSecretSet,
  secretDisplay,
} from './plugins';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  hint: 'var(--text-hint)',
  muted: 'var(--text-muted)',
  text: 'var(--text)',
  warn: 'var(--warn)',
  error: 'var(--error)',
  success: 'var(--success)',
};

/** A `secret` descriptor's value is always a string; the widened settings type
 *  is shared with number/boolean settings, so narrow it at the one call site. */
function asSecret(v: string | number | boolean | undefined): string | boolean | undefined {
  return typeof v === 'number' ? String(v) : v;
}

const field: React.CSSProperties = {
  background: 'var(--bg-input, #101116)',
  border: '1px solid var(--border-2)',
  borderRadius: 3,
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 11.5,
  padding: '5px 8px',
  outline: 'none',
  width: '100%',
};

function Btn({
  label,
  onClick,
  tone = 'default',
  disabled,
}: {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
}) {
  const color = tone === 'accent' ? C.accent : tone === 'danger' ? C.error : C.hint;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: `1px solid ${disabled ? 'var(--border)' : 'var(--border-2)'}`,
        borderRadius: 3,
        color: disabled ? C.faint : color,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 10.5,
        padding: '4px 10px',
      }}
    >
      {label}
    </button>
  );
}

export default function PluginsModal() {
  const open = usePluginsStore((s) => s.modalOpen);
  const close = usePluginsStore((s) => s.closeModal);
  const plugins = usePluginsStore((s) => s.plugins);
  const selectedId = usePluginsStore((s) => s.selectedPluginId);
  const selectPlugin = usePluginsStore((s) => s.selectPlugin);
  const installSpec = usePluginsStore((s) => s.installSpec);
  const setInstallSpec = usePluginsStore((s) => s.setInstallSpec);
  const preview = usePluginsStore((s) => s.preview);
  const setPreview = usePluginsStore((s) => s.setPreview);
  const progress = usePluginsStore((s) => s.installProgress);
  const updateInfo = usePluginsStore((s) => s.updateInfo);
  const setUpdateInfo = usePluginsStore((s) => s.setUpdateInfo);

  const projects = useStore((s) => s.projects);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const selected = useMemo(
    () => plugins.find((p) => p.manifest.id === selectedId) ?? null,
    [plugins, selectedId],
  );

  if (!open) return null;

  const run = async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (!res.ok && res.error) setError(res.error.message);
    setBusy(false);
    return res.ok;
  };

  const resolve = async () => {
    if (!installSpec.trim()) return;
    setBusy(true);
    setError(null);
    const res = await pluginsResolve({ spec: installSpec.trim() });
    if (res.ok) setPreview(res.data);
    else setError(res.error.message);
    setBusy(false);
  };

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-panel-alt, #16171c)',
          border: '1px solid var(--border-2)',
          borderRadius: 6,
          width: 'min(860px, 94vw)',
          maxHeight: 'min(620px, 88vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.accent }}>
              FRANCOIS PLUGINS
            </span>
            <span style={{ fontSize: 10, color: C.faint }}>{plugins.length} installed</span>
          </div>
          {/* §8·C6: said out loud, because the two ecosystems look alike. */}
          <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
            not the same as claude code plugins — these extend francois itself
          </div>
        </div>

        {error && (
          <div style={{ padding: '8px 16px', fontSize: 10.5, color: C.error, borderBottom: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        {preview ? (
          <ConsentCard
            manifest={preview.manifest}
            source={`${preview.source.kind} · ${preview.source.spec} @ ${preview.resolvedRef.slice(0, 7)}`}
            granted={null}
            busy={busy}
            onCancel={() => setPreview(null)}
            onConfirm={async () => {
              const okd = await run(() => pluginsInstall({ stagingId: preview.stagingId }));
              if (okd) {
                setPreview(null);
                setInstallSpec('');
                selectPlugin(preview.manifest.id);
              }
            }}
          />
        ) : (
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* left: install field + the list */}
            <div style={{ width: 300, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                <input
                  value={installSpec}
                  placeholder="acme/francois-ci or an npm package"
                  onChange={(e) => setInstallSpec(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void resolve();
                  }}
                  style={field}
                />
                {progress && (
                  <div style={{ fontSize: 10, color: C.faint, marginTop: 5 }}>
                    {progress.phase}
                    {progress.message ? ` — ${progress.message}` : '…'}
                  </div>
                )}
              </div>
              <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
                {plugins.length === 0 && (
                  <div style={{ fontSize: 10.5, color: C.faint, textAlign: 'center', padding: '16px 0' }}>
                    no plugins installed
                  </div>
                )}
                {plugins.map((p) => {
                  const info = updateInfo[p.manifest.id];
                  return (
                    <div
                      key={p.manifest.id}
                      onClick={() => selectPlugin(p.manifest.id)}
                      style={{
                        padding: '7px 8px',
                        borderRadius: 3,
                        cursor: 'pointer',
                        background: selectedId === p.manifest.id ? 'var(--bg-raised)' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 11.5, color: C.text }}>{p.manifest.name}</span>
                        <span style={{ fontSize: 10, color: C.faint }}>{p.manifest.version}</span>
                      </div>
                      {p.consentPending && (
                        <div style={{ fontSize: 9.5, color: C.warn, marginTop: 2 }}>
                          new permissions — review to re-enable
                        </div>
                      )}
                      {info?.available && (
                        <div style={{ fontSize: 9.5, color: info.capabilitiesWidened ? C.warn : C.hint, marginTop: 2 }}>
                          update available · {info.newVersion}
                          {info.capabilitiesWidened ? ' · new permissions' : ''}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* right: the selected plugin */}
            <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '12px 16px', minWidth: 0 }}>
              {!selected ? (
                <div style={{ fontSize: 10.5, color: C.faint, textAlign: 'center', padding: '24px 0' }}>
                  select a plugin
                </div>
              ) : (
                <Detail
                  plugin={selected}
                  projects={projects}
                  busy={busy}
                  updateAvailable={updateInfo[selected.manifest.id] ?? null}
                  onEnablement={(enablement) =>
                    run(() => pluginsSetEnablement({ pluginId: selected.manifest.id, enablement }))
                  }
                  onSettings={(settings) =>
                    run(() => pluginsSetSettings({ pluginId: selected.manifest.id, settings }))
                  }
                  onUninstall={() =>
                    run(() => pluginsUninstall({ pluginId: selected.manifest.id })).then((okd) => {
                      if (okd) selectPlugin(null);
                    })
                  }
                  onCheckUpdate={async () => {
                    setBusy(true);
                    setError(null);
                    const res = await pluginsCheckUpdate({ pluginId: selected.manifest.id });
                    if (res.ok) setUpdateInfo(selected.manifest.id, res.data);
                    else setError(res.error.message);
                    setBusy(false);
                  }}
                  onUpdate={(consented) =>
                    run(() => pluginsUpdate({ pluginId: selected.manifest.id, consented }))
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** §8·C / FR-11 — everything the user is agreeing to, on one screen. */
function ConsentCard({
  manifest,
  source,
  granted,
  busy,
  onCancel,
  onConfirm,
}: {
  manifest: { name: string; version: string; author?: string; description: string; capabilities: PluginCapabilities };
  source: string;
  /** For an UPDATE: the currently granted set, so additions can be marked `+`. */
  granted: PluginCapabilities | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const caps = manifest.capabilities;
  // FR-13/§8·D15: on an UPDATE the granted set is passed so additions render
  // with a `+` in --warn. On a first install there is nothing to diff against.
  const addedCapabilities = granted
    ? (['readState', 'driveSessions', 'network'] as const).filter((k) =>
        k === 'network' ? caps.network !== undefined && granted.network === undefined : caps[k] === true && granted[k] !== true,
      )
    : [];
  const grantedHosts = new Set((granted?.network?.hosts ?? []).map((h) => h.toLowerCase().replace(/\.$/, '')));
  const addedHosts = granted
    ? (caps.network?.hosts ?? []).filter((h) => !grantedHosts.has(h.toLowerCase().replace(/\.$/, '')))
    : [];
  const rows = capabilityRows(caps, addedCapabilities, addedHosts);
  // FR-11: whenever BOTH are present. Not "when the plugin looks suspicious" —
  // the combination is what matters, and it is not a judgement call.
  const showWarning = caps.readState === true && caps.network !== undefined;

  return (
    <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 13, color: C.text }}>
          {manifest.name} <span style={{ fontSize: 11, color: C.faint }}>{manifest.version}</span>
        </div>
        {manifest.author && <div style={{ fontSize: 10.5, color: C.muted }}>by {manifest.author}</div>}
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{manifest.description}</div>
        {/* FR-11: the source and its PIN — what will actually run. */}
        <div style={{ fontSize: 10, color: C.faint, marginTop: 6 }}>{source}</div>
      </div>

      <div>
        <div style={{ fontSize: 10, letterSpacing: '0.12em', color: C.dim, fontWeight: 700 }}>CAPABILITIES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
          {rows.length === 0 && (
            <span style={{ fontSize: 11, color: C.faint }}>none — it can only draw a panel</span>
          )}
          {rows.map((row) => (
            <span key={row.key} style={{ fontSize: 11, color: row.added ? C.warn : C.text }}>
              {row.added ? '+ ' : '· '}
              {row.sentence}
            </span>
          ))}
        </div>
      </div>

      {(caps.network?.hosts ?? []).length > 0 && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.12em', color: C.dim, fontWeight: 700 }}>NETWORK</div>
          {/* FR-11: verbatim, unabbreviated, in manifest order. A truncated host
              is a host the user did not actually read. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
            {(caps.network?.hosts ?? []).map((h) => {
              const added = addedHosts.includes(h);
              return (
                <span key={h} style={{ fontSize: 11, color: added ? C.warn : C.text, overflowWrap: 'anywhere' }}>
                  {added ? '+ ' : '· '}
                  {h}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {showWarning && (
        <div style={{ fontSize: 10.5, color: C.warn, borderLeft: `2px solid ${C.warn}`, paddingLeft: 8 }}>
          {EXFILTRATION_WARNING}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Btn label={busy ? 'installing…' : 'Install'} tone="accent" onClick={onConfirm} disabled={busy} />
        <Btn label="Cancel" onClick={onCancel} disabled={busy} />
      </div>
    </div>
  );
}

function Detail({
  plugin,
  projects,
  busy,
  updateAvailable,
  onEnablement,
  onSettings,
  onUninstall,
  onCheckUpdate,
  onUpdate,
}: {
  plugin: InstalledPlugin;
  projects: { id: string; name: string }[];
  busy: boolean;
  updateAvailable: { available: boolean; capabilitiesWidened: boolean; newVersion?: string } | null;
  onEnablement: (e: PluginEnablement) => void;
  onSettings: (s: Record<string, string | number | boolean>) => void;
  onUninstall: () => void;
  onCheckUpdate: () => void;
  onUpdate: (consented?: boolean) => void;
}) {
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});
  useEffect(() => setForm({}), [plugin.manifest.id]);

  const descriptors = plugin.manifest.configuration ?? [];
  const scope = plugin.enablement.scope;
  const projectIds = plugin.enablement.scope === 'projects' ? plugin.enablement.projectIds : [];

  const value = (d: PluginSettingDescriptor) =>
    form[d.key] !== undefined ? form[d.key] : plugin.settings[d.key];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div>
        <div style={{ fontSize: 13, color: C.text }}>
          {plugin.manifest.name} <span style={{ fontSize: 11, color: C.faint }}>{plugin.manifest.version}</span>
        </div>
        <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>{plugin.manifest.description}</div>
        <div style={{ fontSize: 10, color: C.faint, marginTop: 5, overflowWrap: 'anywhere' }}>
          {plugin.source.kind} · {plugin.source.spec} @ {plugin.resolvedRef.slice(0, 7)}
        </div>
        {plugin.lastError && (
          <div style={{ fontSize: 10.5, color: C.error, marginTop: 6, overflowWrap: 'anywhere' }}>
            {plugin.lastError.message}
          </div>
        )}
      </div>

      {/* FR-16: a consent-pending plugin can only be reviewed or turned off. */}
      {plugin.consentPending && (
        <div style={{ fontSize: 11, color: C.warn }}>
          new permissions — review to re-enable
        </div>
      )}

      <div>
        <div style={{ fontSize: 10, letterSpacing: '0.12em', color: C.dim, fontWeight: 700 }}>ENABLED IN</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {[
            { key: 'off', label: 'nowhere (off)' },
            { key: 'all', label: 'all projects' },
          ].map((opt) => (
            <label key={opt.key} style={{ fontSize: 11, color: C.text, display: 'flex', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={scope === opt.key}
                onChange={() => onEnablement(opt.key === 'off' ? { scope: 'off' } : { scope: 'all' })}
                disabled={busy || (plugin.consentPending && opt.key !== 'off')}
              />
              {opt.label}
            </label>
          ))}
          {projects.map((p) => (
            <label key={p.id} style={{ fontSize: 11, color: C.text, display: 'flex', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={scope === 'projects' && projectIds.includes(p.id)}
                disabled={busy || plugin.consentPending}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...projectIds, p.id]
                    : projectIds.filter((id) => id !== p.id);
                  onEnablement({ scope: 'projects', projectIds: next });
                }}
              />
              {p.name}
            </label>
          ))}
        </div>
      </div>

      {descriptors.length > 0 && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.12em', color: C.dim, fontWeight: 700 }}>SETTINGS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {descriptors.map((d) => (
              <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 10.5, color: C.dim }}>{d.label}</span>
                {d.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(value(d))}
                    onChange={(e) => onSettings({ [d.key]: e.target.checked })}
                  />
                ) : d.type === 'select' ? (
                  <select
                    value={String(value(d) ?? '')}
                    onChange={(e) => onSettings({ [d.key]: e.target.value })}
                    style={field}
                  >
                    <option value="">—</option>
                    {(d.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'}
                    // FR-64: a set secret shows the sentinel, an unset one the
                    // placeholder. The value itself never came down from the core.
                    placeholder={d.type === 'secret' ? SECRET_PLACEHOLDER : d.placeholder}
                    value={
                      form[d.key] !== undefined
                        ? String(form[d.key])
                        : d.type === 'secret'
                          ? isSecretSet(asSecret(plugin.settings[d.key]))
                            ? SECRET_SENTINEL
                            : ''
                          : String(plugin.settings[d.key] ?? '')
                    }
                    onChange={(e) => setForm((f) => ({ ...f, [d.key]: e.target.value }))}
                    onBlur={(e) => {
                      if (form[d.key] === undefined) return;
                      const raw = e.target.value;
                      onSettings({ [d.key]: d.type === 'number' ? Number(raw) : raw });
                      setForm((f) => {
                        const { [d.key]: _drop, ...rest } = f;
                        return rest;
                      });
                    }}
                    style={field}
                  />
                )}
                {d.description && <span style={{ fontSize: 9.5, color: C.faint }}>{d.description}</span>}
                {d.type === 'secret' && (
                  <>
                    <span style={{ fontSize: 9.5, color: C.faint }}>
                      {secretDisplay(asSecret(plugin.settings[d.key]))}
                    </span>
                    {/* FR-66: the honest sentence. The key sits next to the
                        ciphertext, so this is not secrecy against local access. */}
                    <span style={{ fontSize: 9.5, color: C.faint }}>{SECRETS_NOTE}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn label="check for updates" onClick={onCheckUpdate} disabled={busy} />
        {updateAvailable?.available && (
          <Btn
            label={`update to ${updateAvailable.newVersion}`}
            tone={updateAvailable.capabilitiesWidened ? 'accent' : 'default'}
            // FR-14: a widening update needs an explicit consent flag. The button
            // carries it because the row above already said "new permissions".
            onClick={() => onUpdate(updateAvailable.capabilitiesWidened ? true : undefined)}
            disabled={busy}
          />
        )}
        <Btn label="uninstall" tone="danger" onClick={onUninstall} disabled={busy} />
      </div>
    </div>
  );
}

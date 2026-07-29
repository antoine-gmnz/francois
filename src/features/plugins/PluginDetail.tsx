// plugin-system §8·C9 — the Plugins modal's right column.
//
// Five groups in the brief's order — IDENTITY, PERMISSIONS, ENABLEMENT,
// SETTINGS, LOG — plus the uninstall control. Two of them were missing entirely
// before this pass, and their absence was not cosmetic: without PERMISSIONS the
// user had NO post-install way to see what a plugin was granted, and without
// LOG the FR-26 ring buffer had no way out of the core at all.

import { useEffect, useState } from 'react';
import type {
  InstalledPlugin,
  PluginEnablement,
  PluginSettingDescriptor,
  PluginSettingsView,
  PluginUpdateInfo,
} from '../../../contract/plugin-system';
import { SECRET_SENTINEL } from '../../../contract/plugin-system';
import { pluginsLogs } from '../../lib/api';
import {
  EXFILTRATION_WARNING,
  ENABLEMENT_MODES,
  SECRETS_NOTE,
  SECRET_PLACEHOLDER,
  WIDENING_LINE,
  capabilityRows,
  consentPendingReason,
  enablementMode,
  isSecretSet,
  pendingConsentDiff,
  settingPatch,
  shortRef,
  showsExfiltrationWarning,
  tabUrlHost,
  toggleProjectScope,
  uninstallConfirmText,
  updateRowLabel,
} from './plugins';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  hint: 'var(--text-hint)',
  muted: 'var(--text-muted)',
  text: 'var(--text)',
  bright: 'var(--text-bright)',
  warn: 'var(--warn)',
  error: 'var(--error)',
  success: 'var(--success)',
};

const groupLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  color: C.dim,
};

const field: React.CSSProperties = {
  background: 'var(--bg-deep)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 11,
  padding: '6px 8px',
  outline: 'none',
  width: '100%',
};

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={groupLabel}>{label}</div>
      {children}
    </div>
  );
}

function TextAction({
  label,
  onClick,
  color = C.hint,
  hoverColor,
  disabled,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  hoverColor?: string;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      role="button"
      onClick={() => !disabled && onClick()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 10.5,
        color: disabled ? C.faint : hover && hoverColor ? hoverColor : color,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

export default function PluginDetail({
  plugin,
  projects,
  busy,
  updateInfo,
  onEnablement,
  onSettings,
  onUninstall,
  onCheckUpdate,
  onUpdate,
}: {
  plugin: InstalledPlugin;
  projects: { id: string; name: string }[];
  busy: boolean;
  updateInfo: PluginUpdateInfo | null;
  onEnablement: (e: PluginEnablement) => void;
  onSettings: (patch: PluginSettingsView) => void;
  onUninstall: () => void;
  onCheckUpdate: () => void;
  /**
   * `consented` is NEVER passed here for a widening update — that path goes
   * through the consent card (FR-14, CRITICAL 2). This is the narrowing /
   * unchanged case only.
   */
  onUpdate: () => void;
  }) {
  const id = plugin.manifest.id;
  const descriptors = plugin.manifest.configuration ?? [];
  const mode = enablementMode(plugin.enablement);
  const projectIds = plugin.enablement.scope === 'projects' ? plugin.enablement.projectIds : [];
  const pending = pendingConsentDiff(plugin);
  // Why this plugin is inert — the two reasons must not read alike (§7 #49).
  const reason = consentPendingReason(plugin);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <Identity
        plugin={plugin}
        busy={busy}
        updateInfo={updateInfo}
        onCheckUpdate={onCheckUpdate}
        onUpdate={onUpdate}
      />

      {/* §7 #49: `consent_pending` is ALSO how the core quarantines a registry
          row it does not trust. Nothing was widened there, so the FR-16 copy
          would be a lie — and "review to re-enable" would point at a review
          that does not exist. A tampered entry reads as tampered. */}
      {reason === 'untrusted' && (
        <div
          style={{
            fontSize: 11,
            color: C.error,
            borderLeft: `2px solid ${C.error}`,
            paddingLeft: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span>{plugin.lastError?.message}</span>
          <span style={{ fontSize: 10, color: C.muted }}>
            it stays inert until you reinstall it from its source
          </span>
        </div>
      )}

      {/* FR-16 / §3·F5: a consentPending plugin is inert until re-consent, so
          the detail shows WHAT it now asks for — the sentence alone left the
          user with nothing to review. */}
      {reason === 'widening' && (
        <div
          style={{
            fontSize: 11,
            color: C.warn,
            borderLeft: `2px solid ${C.warn}`,
            paddingLeft: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <span>{WIDENING_LINE}</span>
          {capabilityRows(
            plugin.manifest.capabilities,
            pending.addedCapabilities,
            pending.addedHosts,
            tabUrlHost(plugin.manifest.contributes.tab?.url),
          )
            .filter((r) => r.added)
            .map((r) => (
              <span key={r.key} style={{ fontSize: 11 }}>
                + {r.sentence}
              </span>
            ))}
          {pending.addedHosts.map((h, i) => (
            <span key={`${i}:${h}`} style={{ fontSize: 10.5, overflowWrap: 'anywhere' }}>
              + {h}
            </span>
          ))}
          <span style={{ fontSize: 10, color: C.muted }}>
            it stays inert until you update it from its source, or uninstall it
          </span>
        </div>
      )}

      <Permissions plugin={plugin} />

      <Group label="ENABLEMENT">
        <div style={{ display: 'flex', gap: 14 }}>
          {ENABLEMENT_MODES.map((m) => (
            <span
              key={m.mode}
              role="button"
              onClick={() => {
                if (busy) return;
                if (m.mode === 'off') onEnablement({ scope: 'off' });
                else if (m.mode === 'all') onEnablement({ scope: 'all' });
                else onEnablement({ scope: 'projects', projectIds });
              }}
              style={{
                fontSize: 11,
                color: mode === m.mode ? C.accent : C.faint,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              {m.label}
            </span>
          ))}
        </div>
        {mode === 'projects' && (
          <div
            className="scz"
            style={{ maxHeight: 120, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            {projects.length === 0 && (
              <span style={{ fontSize: 10.5, color: C.faint }}>no projects registered</span>
            )}
            {projects.map((p) => (
              <label
                key={p.id}
                style={{ fontSize: 11, color: C.text, display: 'flex', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={projectIds.includes(p.id)}
                  disabled={busy}
                  onChange={() => onEnablement(toggleProjectScope(plugin.enablement, p.id))}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </Group>

      {descriptors.length > 0 && (
        <Group label="SETTINGS">
          <SettingsForm plugin={plugin} descriptors={descriptors} busy={busy} onSettings={onSettings} />
        </Group>
      )}

      <Group label="LOG">
        <LogView pluginId={id} />
      </Group>

      <UninstallControl name={plugin.manifest.name} busy={busy} onUninstall={onUninstall} />
    </div>
  );
}

/** §8·C9 IDENTITY — plus the update control, which is the only place a widening
 *  update can be started (and it opens the consent card, never sends consent). */
function Identity({
  plugin,
  busy,
  updateInfo,
  onCheckUpdate,
  onUpdate,
}: {
  plugin: InstalledPlugin;
  busy: boolean;
  updateInfo: PluginUpdateInfo | null;
  onCheckUpdate: () => void;
  onUpdate: () => void;
}) {
  const m = plugin.manifest;
  const label = updateInfo ? updateRowLabel(updateInfo) : null;
  return (
    <Group label="IDENTITY">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 12.5, color: C.bright }}>
            {m.name} <span style={{ fontSize: 10.5, color: C.faint }}>{m.version}</span>
          </span>
          {m.author && <span style={{ fontSize: 10.5, color: C.faint }}>{m.author}</span>}
          <span style={{ fontSize: 11, color: C.dim }}>{m.description}</span>
          <span style={{ fontSize: 10.5, color: C.faint, overflowWrap: 'anywhere' }}>
            {plugin.source.kind} · {plugin.source.spec} ·{' '}
            {/* The SHA truncates to 8 with the full value on hover — the pin is
                identity, so it stays reachable without dominating the row. */}
            <span title={plugin.resolvedRef}>{shortRef(plugin.resolvedRef)}</span>
          </span>
          {plugin.lastError && (
            <span style={{ fontSize: 10.5, color: C.error, overflowWrap: 'anywhere' }}>
              {plugin.lastError.message}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <TextAction label="check for updates" onClick={onCheckUpdate} hoverColor={C.accent} disabled={busy} />
          {updateInfo?.available && (
            <TextAction
              label={`update to ${updateInfo.newVersion ?? updateInfo.newRef ?? ''}`}
              onClick={onUpdate}
              color={updateInfo.capabilitiesWidened ? C.warn : C.accent}
              hoverColor={C.accent}
              disabled={busy}
            />
          )}
          {label && <span style={{ fontSize: 10, color: C.faint }}>{label}</span>}
        </div>
      </div>
    </Group>
  );
}

/** §8·C9 PERMISSIONS — the post-install answer to "what did I grant this?". */
function Permissions({ plugin }: { plugin: InstalledPlugin }) {
  const caps = plugin.grantedCapabilities;
  const rows = capabilityRows(caps, [], [], tabUrlHost(plugin.manifest.contributes.tab?.url));
  const hosts = caps.network?.hosts ?? [];
  return (
    <Group label="PERMISSIONS">
      {rows.length === 0 && (
        <span style={{ fontSize: 11, color: C.faint }}>nothing — it can only draw a panel</span>
      )}
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, color: row.glyph === '⚠' ? C.warn : C.success, flexShrink: 0 }}>
            {row.glyph}
          </span>
          <span style={{ fontSize: 11, color: C.text }}>{row.sentence}</span>
        </div>
      ))}
      {hosts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {hosts.map((h, i) => (
            <span
              key={`${i}:${h}`}
              style={{
                fontSize: 10,
                padding: '0 6px',
                border: '1px solid var(--border-2)',
                borderRadius: 3,
                color: C.hint,
                overflowWrap: 'anywhere',
              }}
            >
              {h}
            </span>
          ))}
        </div>
      )}
      {/* §8·C9: the C4 warning REPEATS here — the combination is as true after
          install as it was on the card. */}
      {showsExfiltrationWarning(caps) && (
        <div
          style={{
            fontSize: 10.5,
            lineHeight: 1.6,
            color: C.warn,
            borderLeft: `2px solid ${C.warn}`,
            paddingLeft: 8,
          }}
        >
          {EXFILTRATION_WARNING}
        </div>
      )}
    </Group>
  );
}

/** §8·C9 SETTINGS — FR-61..FR-64. Every commit goes through `settingPatch`. */
function SettingsForm({
  plugin,
  descriptors,
  busy,
  onSettings,
}: {
  plugin: InstalledPlugin;
  descriptors: PluginSettingDescriptor[];
  busy: boolean;
  onSettings: (patch: PluginSettingsView) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setDraft({});
    setInvalid({});
  }, [plugin.manifest.id]);

  const firstSecret = descriptors.find((d) => d.type === 'secret');

  const commit = (d: PluginSettingDescriptor, raw: string | boolean) => {
    // FR-63/FR-64: the patch helper decides. `Number('')` is 0, so sending the
    // raw value silently wrote 0 for a cleared number field; a select outside
    // its options and an over-long string were never checked at all; and the
    // secret sentinel is a NO-OP that preserves the stored value rather than a
    // write.
    const patch = settingPatch(d, raw);
    if (!patch) {
      setInvalid((s) => ({ ...s, [d.key]: true }));
      return;
    }
    setInvalid((s) => ({ ...s, [d.key]: false }));
    onSettings(patch);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {descriptors.map((d) => {
        const stored = plugin.settings[d.key];
        const secretSet = d.type === 'secret' && isSecretSet(typeof stored === 'number' ? String(stored) : stored);
        const shown =
          draft[d.key] !== undefined
            ? draft[d.key]
            : d.type === 'secret'
              ? secretSet
                ? SECRET_SENTINEL
                : ''
              : String(stored ?? d.default ?? '');
        return (
          <div key={d.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 10.5, color: C.muted, width: 140, flexShrink: 0, paddingTop: 5 }}>
              {d.label}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {d.type === 'boolean' ? (
                <span
                  role="button"
                  onClick={() => !busy && commit(d, !(stored === true || (stored === undefined && d.default === true)))}
                  style={{ fontSize: 12, color: C.accent, cursor: busy ? 'default' : 'pointer' }}
                >
                  {stored === true || (stored === undefined && d.default === true) ? '◉' : '○'}
                </span>
              ) : d.type === 'select' ? (
                <select
                  value={String(stored ?? d.default ?? '')}
                  disabled={busy}
                  onChange={(e) => commit(d, e.target.value)}
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
                  placeholder={d.type === 'secret' ? SECRET_PLACEHOLDER : d.placeholder}
                  value={shown}
                  disabled={busy}
                  onChange={(e) => setDraft((s) => ({ ...s, [d.key]: e.target.value }))}
                  onBlur={(e) => {
                    if (draft[d.key] === undefined) return;
                    commit(d, e.target.value);
                    setDraft((s) => {
                      const { [d.key]: _drop, ...rest } = s;
                      return rest;
                    });
                  }}
                  style={{
                    ...field,
                    borderColor: invalid[d.key] ? 'var(--error)' : 'var(--border-2)',
                  }}
                />
              )}
              {invalid[d.key] && (
                <span style={{ fontSize: 10, color: C.error }}>
                  {d.type === 'number'
                    ? `a number${d.min !== undefined ? ` ≥ ${d.min}` : ''}${d.max !== undefined ? ` ≤ ${d.max}` : ''}`
                    : 'not an accepted value'}
                </span>
              )}
              {/* §8·C9 / FR-64: a set secret is CLEARABLE. Without this the user
                  cannot remove a stored token from the UI at all. */}
              {secretSet && (
                <TextAction
                  label="clear"
                  color={C.faint}
                  hoverColor={C.error}
                  disabled={busy}
                  onClick={() => commit(d, '')}
                />
              )}
              {d.description && <span style={{ fontSize: 10, color: C.faint }}>{d.description}</span>}
              {/* FR-66: the honest sentence, once, under the FIRST secret field.
                  The key sits next to the ciphertext — this is obfuscation, not
                  protection against local access. */}
              {firstSecret?.key === d.key && (
                <span style={{ fontSize: 10, color: C.faint }}>{SECRETS_NOTE}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** §8·C9 LOG — FR-26's ring buffer, over `francois:plugins:logs`. */
function LogView({ pluginId }: { pluginId: string }) {
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    setLines(null);
    void pluginsLogs({ pluginId })
      .then((res) => {
        if (live) setLines(res.ok ? res.data : []);
      })
      .catch(() => {
        if (live) setLines([]);
      });
    return () => {
      live = false;
    };
  }, [pluginId]);

  return (
    <div
      className="scz"
      style={{
        fontSize: 10,
        color: C.muted,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: 140,
        overflow: 'auto',
        background: 'var(--bg-deep)',
        padding: '6px 8px',
        borderRadius: 4,
      }}
    >
      {lines === null ? '…' : lines.length === 0 ? 'no output' : lines.join('\n')}
    </div>
  );
}

/** §8·C9 — the uninstall control, which swaps IN PLACE for its confirmation.
 *  FR-74 makes this irreversible: tree, storage, registry entry and log buffer. */
function UninstallControl({
  name,
  busy,
  onUninstall,
}: {
  name: string;
  busy: boolean;
  onUninstall: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <TextAction
          label="uninstall"
          color={C.muted}
          hoverColor={C.error}
          disabled={busy}
          onClick={() => setConfirming(true)}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: 14,
      }}
    >
      <span style={{ fontSize: 10.5, color: C.error, overflowWrap: 'anywhere' }}>
        {uninstallConfirmText(name)}
      </span>
      <TextAction label="cancel" color={C.muted} disabled={busy} onClick={() => setConfirming(false)} />
      <TextAction
        label="uninstall"
        color={C.error}
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          onUninstall();
        }}
      />
    </div>
  );
}

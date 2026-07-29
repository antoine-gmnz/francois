// plugin-system §8·C — the FRANCOIS PLUGINS modal.
//
// The word FRANCOIS in the title is load-bearing (§8·C6): it is what separates
// this from the Claude Code plugins `skills-panel` already surfaces. The two
// never touch — installing here writes nothing to `~/.claude/` (FR-8).
//
// This file is the SHELL: the header, the left list with its install field, and
// the routing between the detail column and the consent card. The consent card
// (`PluginConsentCard`) and the detail column (`PluginDetail`) own their own
// files — the modal was one 600-line component and the two groups it was
// missing would have pushed it past the size limit.
//
// The one rule that must not move: a WIDENING update reaches
// `pluginsUpdate({ consented: true })` only through the consent card's confirm
// (FR-10/FR-14). The core does not enforce that the human saw the card, so this
// routing IS the control.

import { useEffect, useMemo, useState } from 'react';
import type {
  PluginEnablement,
  PluginSettingsView,
  PluginStatusOutput,
} from '../../../contract/plugin-system';
import {
  pluginsCheckUpdate,
  pluginsInstall,
  pluginsResolve,
  pluginsSetEnablement,
  pluginsSetSettings,
  pluginsStatus,
  pluginsUninstall,
  pluginsUpdate,
} from '../../lib/api';
import { useStore } from '../../lib/store';
import PluginConsentCard from './PluginConsentCard';
import PluginDetail from './PluginDetail';
import { usePluginsStore } from './pluginsStore';
import {
  EMPTY_DETAIL_LINE,
  EMPTY_LIST_LINE,
  INSTALL_PLACEHOLDER,
  MODAL_SUBTITLE,
  MODAL_TITLE,
  REGISTRY_RESET_LINE,
  SECRETS_UNREADABLE_NOTE,
  installPhaseLabel,
  installedCountLabel,
  pluginRowSubtitle,
  pluginRowTags,
} from './plugins';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  muted: 'var(--text-muted)',
  text: 'var(--text)',
  bright: 'var(--text-bright)',
  warn: 'var(--warn)',
  error: 'var(--error)',
};

const ROW_TONE = {
  faint: C.faint,
  error: C.error,
  warn: C.warn,
  accent: C.accent,
} as const;

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
  /** The plugin whose WIDENING update consent card is open (FR-14). */
  const [consentFor, setConsentFor] = useState<string | null>(null);
  /** §7 #40 / §7 #42 — the two app-wide conditions, read once per opening. */
  const [status, setStatus] = useState<PluginStatusOutput | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
      setConsentFor(null);
      setStatus(null);
    }
  }, [open]);

  // `registryWasReset` is CLEARED BY THE READ (§5.4), so this runs exactly once
  // per opening and the answer is held in component state. Polling it — or
  // re-reading on any re-render — would consume the flag and make the message
  // flash and vanish.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void pluginsStatus()
      .then((res) => {
        if (live && res.ok) setStatus(res.data);
      })
      .catch(() => {
        /* the modal works without it; there is nothing useful to say here */
      });
    return () => {
      live = false;
    };
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

  /**
   * Every bridge call in this modal goes through here. The `finally` is not
   * housekeeping: an `await` that REJECTS (a bridge fault, not a domain error)
   * used to leave `busy` stuck true, which disables every control in the modal
   * with no error shown and no way back except closing it.
   */
  const run = async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok && res.error) setError(res.error.message);
      return res.ok;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the request could not be sent');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const resolve = () => {
    if (!installSpec.trim()) return;
    void run(async () => {
      const res = await pluginsResolve({ spec: installSpec.trim() });
      if (res.ok) setPreview(res.data);
      return res;
    });
  };

  const consentPlugin = consentFor ? plugins.find((p) => p.manifest.id === consentFor) ?? null : null;
  const consentInfo = consentFor ? (updateInfo[consentFor] ?? null) : null;

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
              {MODAL_TITLE}
            </span>
            <span style={{ fontSize: 10, color: C.faint }}>{installedCountLabel(plugins.length)}</span>
          </div>
          {/* §8·C6: said out loud, because the two ecosystems look alike. */}
          <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{MODAL_SUBTITLE}</div>
        </div>

        {/* §7 #40 — shown ONCE: the core clears the flag when it is read, and
            what it reports happened once, at startup. */}
        {status?.registryWasReset && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: 10.5,
              color: C.warn,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {REGISTRY_RESET_LINE}
          </div>
        )}

        {/* §7 #42 / FR-66 — a STANDING condition, not an event: while the key is
            missing every enc:v1: value reads as unset, and saying so is the
            difference between "my token vanished" and "the key is gone". */}
        {status?.secretsUnreadable && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: 10.5,
              color: C.error,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {SECRETS_UNREADABLE_NOTE}
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: 10.5,
              color: C.error,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* left: the list + the install field */}
          <div
            style={{
              width: 260,
              flexShrink: 0,
              borderRight: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
              {plugins.length === 0 && (
                <div style={{ fontSize: 11, color: C.faint, textAlign: 'center', padding: '16px 0' }}>
                  {EMPTY_LIST_LINE}
                </div>
              )}
              {plugins.map((p) => {
                const info = updateInfo[p.manifest.id];
                const isSelected = selectedId === p.manifest.id;
                return (
                  <div
                    key={p.manifest.id}
                    onClick={() => {
                      selectPlugin(p.manifest.id);
                      setConsentFor(null);
                    }}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 3,
                      cursor: 'pointer',
                      background: isSelected ? 'var(--bg-raised)' : 'transparent',
                      borderLeft: `2px solid ${isSelected ? C.accent : 'transparent'}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 11.5, color: isSelected ? C.bright : C.text }}>
                        {p.manifest.name}
                      </span>
                      <span style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                        {pluginRowTags(p, info?.available === true).map((tag) => (
                          <span key={tag.label} style={{ fontSize: 9, color: ROW_TONE[tag.tone] }}>
                            {tag.label}
                          </span>
                        ))}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{pluginRowSubtitle(p)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
              <input
                value={installSpec}
                placeholder={INSTALL_PLACEHOLDER}
                onChange={(e) => setInstallSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') resolve();
                }}
                style={{
                  background: 'var(--bg-deep)',
                  border: '1px solid var(--border-2)',
                  borderRadius: 4,
                  color: 'var(--text)',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  padding: '6px 8px',
                  outline: 'none',
                  width: '100%',
                }}
              />
              {progress && (
                <div style={{ fontSize: 10, color: C.faint, marginTop: 5 }}>
                  {installPhaseLabel(progress.phase)}
                  {progress.message ? ` — ${progress.message}` : ''}
                </div>
              )}
            </div>
          </div>

          {/* right: the consent card REPLACES the detail column (§8·D11) */}
          {preview ? (
            <PluginConsentCard
              header="INSTALL PLUGIN"
              manifest={preview.manifest}
              source={preview.source}
              resolvedRef={preview.resolvedRef}
              unpackedBytes={preview.unpackedBytes}
              granted={null}
              addedCapabilities={[]}
              addedHosts={[]}
              widening={false}
              busy={busy}
              confirmLabel="install"
              onCancel={() => setPreview(null)}
              onConfirm={() => {
                void run(() => pluginsInstall({ stagingId: preview.stagingId })).then((okd) => {
                  if (okd) {
                    setPreview(null);
                    setInstallSpec('');
                    selectPlugin(preview.manifest.id);
                  }
                });
              }}
            />
          ) : consentPlugin && consentInfo ? (
            consentInfo.newManifest ? (
              <PluginConsentCard
                header="UPDATE PLUGIN"
                manifest={consentInfo.newManifest}
                source={consentPlugin.source}
                resolvedRef={consentInfo.newRef ?? consentInfo.currentRef}
                granted={consentPlugin.grantedCapabilities}
                // The CORE computes the diff. `PLUGIN_CAPABILITY_KEYS` types
                // `addedCapabilities`, so `webTab` is reportable there too and
                // the frontend has nothing to add.
                addedCapabilities={consentInfo.addedCapabilities}
                addedHosts={consentInfo.addedHosts}
                widening={consentInfo.capabilitiesWidened}
                busy={busy}
                confirmLabel="update"
                onCancel={() => setConsentFor(null)}
                // FR-14: the ONE place `consented: true` is sent, and it is
                // reachable only from a card that showed what is being granted.
                onConfirm={() => {
                  void run(() =>
                    pluginsUpdate({ pluginId: consentPlugin.manifest.id, consented: true }),
                  ).then((okd) => {
                    if (okd) {
                      setUpdateInfo(consentPlugin.manifest.id, null);
                      setConsentFor(null);
                    }
                  });
                }}
              />
            ) : (
              <div className="scz" style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                <div style={{ fontSize: 11, color: C.warn }}>
                  this update's manifest could not be read — check for updates again
                </div>
              </div>
            )
          ) : (
            <div
              className="scz"
              style={{ flex: 1, overflow: 'auto', padding: '14px 16px', minWidth: 0 }}
            >
              {!selected ? (
                <div style={{ fontSize: 10.5, color: C.muted, textAlign: 'center', padding: '24px 0' }}>
                  {EMPTY_DETAIL_LINE}
                </div>
              ) : (
                <PluginDetail
                  plugin={selected}
                  projects={projects}
                  busy={busy}
                  updateInfo={updateInfo[selected.manifest.id] ?? null}
                  onEnablement={(enablement: PluginEnablement) => {
                    void run(() => pluginsSetEnablement({ pluginId: selected.manifest.id, enablement }));
                  }}
                  onSettings={(settings: PluginSettingsView) => {
                    void run(() => pluginsSetSettings({ pluginId: selected.manifest.id, settings }));
                  }}
                  onUninstall={() => {
                    void run(() => pluginsUninstall({ pluginId: selected.manifest.id })).then((okd) => {
                      if (okd) selectPlugin(null);
                    });
                  }}
                  onCheckUpdate={() => {
                    void run(async () => {
                      const res = await pluginsCheckUpdate({ pluginId: selected.manifest.id });
                      if (res.ok) setUpdateInfo(selected.manifest.id, res.data);
                      return res;
                    });
                  }}
                  onUpdate={() => {
                    const info = updateInfo[selected.manifest.id];
                    if (!info?.available) return;
                    // FR-14: a widening update NEVER goes straight through. It
                    // opens the consent card, which is the only caller that may
                    // send `consented: true`.
                    if (info.capabilitiesWidened) {
                      setConsentFor(selected.manifest.id);
                      return;
                    }
                    void run(() => pluginsUpdate({ pluginId: selected.manifest.id })).then((okd) => {
                      if (okd) setUpdateInfo(selected.manifest.id, null);
                    });
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

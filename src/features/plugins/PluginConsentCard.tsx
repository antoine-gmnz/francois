// plugin-system §8·D / FR-10, FR-11, FR-13 — the install / update consent card.
//
// This is the one screen in Francois whose job is to be READ rather than
// skimmed, and FR-10 puts its enforcement here rather than in the core: "the
// core does not enforce that the human saw it". So this component is the
// control. `onConfirm` is the only thing in the frontend that may send
// `consented: true` for a widening update — a button elsewhere that passes the
// flag without rendering this card is the bug this file exists to prevent.
//
// It states the source and its PIN in full, every capability in plain language,
// every host verbatim, the framed tab as its own line (§8·H36), and — when both
// readState and network are granted — the standing warning that those two
// together are an exfiltration channel.

import type {
  PluginCapabilities,
  PluginCapabilityKey,
  PluginManifest,
  PluginSource,
} from '../../../contract/plugin-system';
import {
  EXFILTRATION_WARNING,
  WIDENING_LINE,
  capabilityRows,
  humanBytes,
  showsExfiltrationWarning,
  sourceLine,
  tabUrlHost,
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
};

const groupLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
};

export default function PluginConsentCard({
  header,
  manifest,
  source,
  resolvedRef,
  unpackedBytes,
  granted,
  addedCapabilities,
  addedHosts,
  widening,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  /** §8·D11 — `INSTALL PLUGIN` or `UPDATE PLUGIN`. */
  header: string;
  manifest: PluginManifest;
  source: PluginSource;
  resolvedRef: string;
  unpackedBytes?: number;
  /** The currently granted set on an UPDATE; null on a first install. */
  granted: PluginCapabilities | null;
  addedCapabilities: readonly PluginCapabilityKey[];
  addedHosts: readonly string[];
  widening: boolean;
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  /** The ONLY caller allowed to send `consented: true` (FR-14). */
  onConfirm: () => void;
}) {
  const caps = manifest.capabilities;
  const rows = capabilityRows(
    caps,
    addedCapabilities,
    addedHosts,
    tabUrlHost(manifest.contributes.tab?.url),
  );
  const hosts = caps.network?.hosts ?? [];
  const isUpdate = granted !== null;

  // §8·D15: on an update, added rows are `+` in --warn and already-granted ones
  // dim. On a first install every row is new, so none of them dims.
  const rowColor = (added: boolean) => (added ? C.warn : isUpdate ? C.faint : C.text);

  return (
    <div
      className="scz"
      style={{
        flex: 1,
        overflow: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        opacity: busy ? 0.7 : 1,
      }}
    >
      <div style={{ ...groupLabel, color: C.accent }}>{header}</div>

      {/* §8·D12 — identity. The ref is shown IN FULL: on this card the pin is
          the security-relevant datum, not a decoration to abbreviate. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 13, color: C.bright }}>{manifest.name}</div>
        <div style={{ fontSize: 10.5, color: C.faint }}>
          {manifest.version}
          {manifest.author ? ` · ${manifest.author}` : ''}
        </div>
        <div style={{ fontSize: 11.5, color: C.text }}>{manifest.description}</div>
        <div style={{ fontSize: 10.5, color: C.muted, overflowWrap: 'anywhere' }}>
          {sourceLine(source, resolvedRef)}
          {unpackedBytes !== undefined ? ` · ${humanBytes(unpackedBytes)}` : ''}
        </div>
      </div>

      {/* §8·D13 — capabilities, in plain language. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ ...groupLabel, color: C.warn }}>THIS PLUGIN CAN</div>
        {rows.length === 0 && (
          <span style={{ fontSize: 11.5, color: C.faint }}>nothing — it can only draw a panel</span>
        )}
        {rows.map((row) => (
          <div key={row.key} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11.5, color: C.warn, flexShrink: 0 }}>{row.added ? '+' : '⚠'}</span>
            <span style={{ fontSize: 11.5, color: rowColor(row.added) }}>{row.sentence}</span>
          </div>
        ))}
        {/* §8·D13: the hosts follow as chips, one per host, wrapping, VERBATIM.
            A truncated host is a host the user did not actually read. */}
        {hosts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
            {hosts.map((h, i) => {
              const added = addedHosts.includes(h);
              return (
                // Keyed by index too: a manifest may legally repeat a host, and
                // a duplicate React key drops the second one from the list.
                <span
                  key={`${i}:${h}`}
                  style={{
                    fontSize: 10,
                    padding: '0 6px',
                    border: `1px solid ${added ? C.warn : 'var(--border-2)'}`,
                    borderRadius: 3,
                    color: added ? C.warn : C.hint,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {added ? '+ ' : ''}
                  {h}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* §8·D14 — shown whenever BOTH are present. Not "when the plugin looks
          suspicious": the combination is what matters, and it is not a
          judgement call. */}
      {showsExfiltrationWarning(caps) && (
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: C.warn,
            background: 'var(--accent-soft-bg)',
            borderLeft: `2px solid ${C.warn}`,
            borderRadius: 3,
            padding: '8px 10px',
          }}
        >
          {EXFILTRATION_WARNING}
        </div>
      )}

      {/* §8·D15 — the one extra line a widening update carries. */}
      {widening && <div style={{ fontSize: 11, color: C.warn }}>{WIDENING_LINE}</div>}

      {/* §8·D16 — right-aligned, inert while in flight. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginTop: 2 }}>
        <span
          role="button"
          onClick={() => !busy && onCancel()}
          style={{ fontSize: 11, color: C.muted, cursor: busy ? 'default' : 'pointer' }}
        >
          cancel
        </span>
        <span
          role="button"
          onClick={() => !busy && onConfirm()}
          style={{ fontSize: 11, color: C.accent, cursor: busy ? 'default' : 'pointer' }}
        >
          {confirmLabel}
        </span>
      </div>
    </div>
  );
}

// permission-guardrails — the rules editor (spec §8.10–14, FR-26..FR-29).
// "See what I've trusted": once a rule exists, Claude enforces it upstream of
// the control channel and the matching calls never produce a card again — so
// THIS modal is the only place those decisions are visible.
//
// Reads on open and after every mutation (the core returns the freshly re-read
// list, FR-18). Pure logic lives in ./permissions-editor.

import { useEffect, useMemo, useState } from 'react';
import type { PermissionRule } from '../../../contract/permission-guardrails';
import { permissionsList, permissionsRemove, permissionsSetEnabled, permissionsSetTier } from '../../lib/api';
import {
  applyMutation,
  effectGlyph,
  effectLabel,
  emptyText,
  filterRules,
  groupRules,
  moveLabel,
  otherTier,
} from './permissions-editor';
import { tierChip } from './permission-card';
import { sessionCapability } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { CapabilityNotice } from '../../ui/CapabilityNotice';
import './permissions.css';

export default function PermissionsModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const meta = useStore((st) => st.sessions.find((x) => x.id === sessionId) ?? null);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // multi-provider-codex FR-11: on a runtime whose tool calls these rules do not
  // govern, the editor says so instead of listing rules that decide nothing. A
  // Codex session is sandboxed by Codex itself (FR-9), so the rules here would
  // be read by no one — and an editor that silently governs nothing is worse
  // than one that is honestly switched off.
  const capability = sessionCapability(meta, 'permissions');

  // FR-26: read-on-open. v1 does not watch the settings files, so opening the
  // modal IS the refresh — three processes write them (§7 #7).
  useEffect(() => {
    if (!capability.available) {
      setLoading(false);
      return;
    }
    let mounted = true;
    void permissionsList(sessionId).then((res) => {
      if (!mounted) return;
      if (res.ok) setRules(res.data);
      else setError(res.error.message);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId, capability.available]);

  // FR-29: Escape closes — BUBBLE phase, the convention every other modal follows
  // (NewSessionModal, McpPanel, SkillsPanel, AgentsPanel). App.tsx's own
  // capture-phase Escape handler calls stopPropagation() when the palette is
  // open, which cancels the bubble pass entirely; a capture-phase listener here
  // would ignore that (it needs stopImmediatePropagation) and one Escape would
  // dismiss the palette AND close this modal, discarding the filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => filterRules(rules, query), [rules, query]);
  const groups = useMemo(() => groupRules(filtered), [filtered]);
  const empty = emptyText(rules.length, filtered.length, query);

  const mutate = (call: () => Promise<import('../../../contract/common').Result<PermissionRule[]>>) =>
    void applyMutation({ call, setRules, setError, setBusy });

  return (
    <div className="pmodal-backdrop" onClick={onClose}>
      {/* FR-29: backdrop click closes */}
      <div className="pmodal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pmodal-title-row">
          <span className="pmodal-title">PERMISSION RULES</span>
          {/* Runtime-neutral: FR-13 puts a WSL session's global tier in the
              DISTRO's $HOME, so naming ~/.claude here would misstate where a
              promoted rule actually lands. */}
          <span className="pmodal-subtitle">project · global Claude settings</span>
          <span onClick={onClose} className="pmodal-close" title="close · Esc">
            ✕
          </span>
        </div>

        {!capability.available ? (
          // multi-provider-codex FR-11 — the whole body, replaced by the one
          // dim line the table supplies. Not an empty list and not a disabled
          // form: there is nothing here to filter, and offering the controls
          // greyed out would still imply they would work if only you were
          // allowed. The reason is rendered verbatim (the contract owns the
          // copy), and the footer below is swapped for the same reason — it
          // names Claude, which is the wrong runtime to name here.
          <CapabilityNotice reason={capability.reason!} />
        ) : (
          <>
        <input
          value={query}
          autoFocus
          placeholder="filter rules…"
          onChange={(e) => setQuery(e.target.value)}
          className="pmodal-filter"
        />

        {error !== null && <div className="pmodal-error">{error}</div>}

        {/* `busy` already drops concurrent row clicks; this gives that a visible
            affordance instead of silently swallowing them. No transition (§8). */}
        <div className={'scz pmodal-list' + (busy ? ' pmodal-list--busy' : '')}>
          {loading ? (
            <div className="prules-empty">reading settings…</div>
          ) : empty !== null ? (
            <div className="prules-empty">{empty}</div>
          ) : (
            groups.map((group) => (
              <div key={group.effect}>
                <div className="prules-group">{effectLabel(group.effect)}</div>
                {/* Key by id AND index: a hand-edited settings file can repeat a
                    pattern inside one effect array, and ids are derived. */}
                {group.rules.map((r, i) => (
                  <div key={`${r.id}#${i}`} className={'prule' + (r.enabled ? '' : ' prule-off')}>
                    <span className={`prule-glyph prule-glyph-${r.effect}`}>{effectGlyph(r.effect)}</span>
                    <span className="prule-label">{r.label}</span>
                    <span className="prule-pattern">{r.pattern}</span>
                    <span className="prule-tier">{tierChip(r.tier)}</span>
                    <span
                      className="prule-act"
                      title={r.enabled ? 'disable this rule' : 'enable this rule'}
                      onClick={() => {
                        if (!busy) mutate(() => permissionsSetEnabled(sessionId, r.id, !r.enabled));
                      }}
                    >
                      {r.enabled ? '◉' : '○'}
                    </span>
                    <span
                      className="prule-act"
                      title={`move to the ${otherTier(r.tier)} tier`}
                      onClick={() => {
                        if (!busy) mutate(() => permissionsSetTier(sessionId, r.id, otherTier(r.tier)));
                      }}
                    >
                      {moveLabel(r.tier)}
                    </span>
                    <span
                      className="prule-act prule-del"
                      title="delete this rule"
                      onClick={() => {
                        if (!busy) mutate(() => permissionsRemove(sessionId, r.id));
                      }}
                    >
                      ✕
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="pmodal-footer">Claude enforces these itself — a ruled call never asks again.</div>
          </>
        )}
      </div>
    </div>
  );
}

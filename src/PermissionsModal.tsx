// permission-guardrails — the rules editor (spec §8.10–14, FR-26..FR-29).
// "See what I've trusted": once a rule exists, Claude enforces it upstream of
// the control channel and the matching calls never produce a card again — so
// THIS modal is the only place those decisions are visible.
//
// Reads on open and after every mutation (the core returns the freshly re-read
// list, FR-18). Pure logic lives in ./permissions-editor.

import { useEffect, useMemo, useState } from 'react';
import type { PermissionRule } from '../contract/permission-guardrails';
import { permissionsList, permissionsRemove, permissionsSetEnabled, permissionsSetTier } from './api';
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

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  error: 'var(--error)',
};

export default function PermissionsModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // FR-26: read-on-open. v1 does not watch the settings files, so opening the
  // modal IS the refresh — three processes write them (§7 #7).
  useEffect(() => {
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
  }, [sessionId]);

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

  const mutate = (call: () => Promise<import('../contract/common').Result<PermissionRule[]>>) =>
    void applyMutation({ call, setRules, setError, setBusy });

  return (
    <div
      onClick={onClose} // FR-29: backdrop click closes
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-2)',
          borderRadius: 6,
          width: 'min(720px, 92vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '14px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 10, letterSpacing: '0.12em', color: C.accent }}>PERMISSION RULES</span>
          {/* Runtime-neutral: FR-13 puts a WSL session's global tier in the
              DISTRO's $HOME, so naming ~/.claude here would misstate where a
              promoted rule actually lands. */}
          <span style={{ fontSize: 10, color: C.faint, flex: 1 }}>project · global Claude settings</span>
          <span onClick={onClose} style={{ fontSize: 11, color: C.faint, cursor: 'pointer' }} title="close · Esc">
            ✕
          </span>
        </div>

        <input
          value={query}
          autoFocus
          placeholder="filter rules…"
          onChange={(e) => setQuery(e.target.value)}
          style={{
            marginTop: 10,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-2)',
            borderRadius: 4,
            height: 30,
            color: 'var(--text)',
            fontSize: 12,
            fontFamily: 'inherit',
            padding: '0 10px',
            outline: 'none',
            flexShrink: 0,
          }}
        />

        {error !== null && (
          <div style={{ marginTop: 8, fontSize: 11, color: C.error, flexShrink: 0 }}>{error}</div>
        )}

        {/* `busy` already drops concurrent row clicks; this gives that a visible
            affordance instead of silently swallowing them. No transition (§8). */}
        <div
          className="scz"
          style={{
            marginTop: 6,
            overflowY: 'auto',
            minHeight: 0,
            flex: 1,
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? 'none' : undefined,
          }}
        >
          {loading ? (
            <div className="prules-empty">reading settings…</div>
          ) : empty !== null ? (
            <div className="prules-empty">{empty}</div>
          ) : (
            groups.map((g) => (
              <div key={g.effect}>
                <div className="prules-group">{effectLabel(g.effect)}</div>
                {/* Key by id AND index: a hand-edited settings file can repeat a
                    pattern inside one effect array, and ids are derived. */}
                {g.rules.map((r, i) => (
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

        <div style={{ marginTop: 10, fontSize: 10, color: C.dim, flexShrink: 0 }}>
          Claude enforces these itself — a ruled call never asks again.
        </div>
      </div>
    </div>
  );
}

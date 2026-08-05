import { Bot, Plug, Sparkles, Workflow } from 'lucide-react';
import { focusedSessionId } from '../lib/layoutStore';
import { EMPTY_PANEL_COUNTS, type CountedPane } from '../lib/panelCountsStore';
import { useStore } from '../lib/store';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const RAIL: readonly { pane: CountedPane; key: number; label: string; glyph: JSX.Element }[] = [
  { pane: 'agents', key: 3, label: 'Agents', glyph: <Bot {...ICON} /> },
  { pane: 'mcp', key: 4, label: 'MCP', glyph: <Plug {...ICON} /> },
  { pane: 'skills', key: 5, label: 'Skills', glyph: <Sparkles {...ICON} /> },
  { pane: 'workflows', key: 6, label: 'Workflows', glyph: <Workflow {...ICON} /> },
];

/**
 * split-session FR-2 / design §Right column: the 46px icon rail the right
 * column folds to while split. One 30px button per pane; clicking it focuses
 * that pane, which (setFocusedPane's invariant) reveals the full column again —
 * exactly what `]` does.
 *
 * Each button badges its pane's own count, scoped to the FOCUSED session (FR-7).
 * The counts come from the panels themselves (panelCountsStore) — they are the
 * only mounts holding them, and the panes stay MOUNTED behind this rail
 * (`.app-col-right` is `display:none`, never unmounted), so their feeds keep
 * publishing while folded.
 */
export default function RightRail() {
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const sessionId = useStore((s) => focusedSessionId(s));
  const counts = useStore((s) => (sessionId ? (s.panelCounts.get(sessionId) ?? EMPTY_PANEL_COUNTS) : EMPTY_PANEL_COUNTS));
  // The mock's one warm badge: agents while subagents are actually running —
  // the count itself is the roster size, so the colour carries the liveness.
  const runningAgents = useStore((s) => (sessionId ? (s.derived.get(sessionId)?.runningAgentCount ?? 0) : 0));

  return (
    <aside className="app-rail">
      {RAIL.map((r) => {
        const count = counts[r.pane];
        const live = r.pane === 'agents' && runningAgents > 0;
        return (
          <button
            key={r.pane}
            type="button"
            className="app-rail__btn"
            title={`${r.label} · ${r.key}`}
            onClick={() => setFocusedPane(r.pane)}
          >
            {r.glyph}
            {count > 0 && (
              <span className={live ? 'app-rail__badge app-rail__badge--live' : 'app-rail__badge'}>{count}</span>
            )}
          </button>
        );
      })}
    </aside>
  );
}

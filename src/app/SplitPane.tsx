import { Maximize2 } from 'lucide-react';
import type { SessionId } from '../../contract/common';
import { formatContextTokens } from '../../contract/conversation-view';
import { STATUS_COLOR, STATUS_LABEL, statusPulses } from '../../contract/fleet-board';
import ConversationView from '../features/conversation/ConversationView';
import DiffView from '../features/diff/DiffView';
import type { PaneTab, SplitSide } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { BadgePill } from '../ui/BadgePill';
import { StatusDot } from '../ui/StatusDot';
import EmptyPaneMessage from './EmptyPaneMessage';
import ShellTabView from './ShellTabView';

export interface SplitPaneProps {
  side: SplitSide;
  sessionId: SessionId | null;
  tab: PaneTab;
  focused: boolean;
  home: string;
  onFocus: () => void;
  onTab: (tab: PaneTab) => void;
  /** ⤢ — FR-12: leave split, promoting this pane to the single main pane. */
  onPromote: () => void;
}

const TABS: readonly { id: PaneTab; label: string }[] = [
  { id: 'session', label: 'Session' },
  { id: 'diff', label: 'Diff' },
  { id: 'shell', label: 'Shell' },
];

/**
 * split-session FR-4/FR-6 — one of the two main panes: its own header (status
 * dot, name, `focus` chip or status label, context tokens, ⤢), its own
 * Session/Diff/Shell strip with its own diff badge, and its own body.
 *
 * Deliberately NOT `MainTabStrip` + `MainPaneBody`: a split pane carries a
 * *sub*-level strip (sentence-case text tabs, no segmented track) and only the
 * three tabs FR-13 allows, so reusing the shell's own strip would read as two
 * competing top-level chromes.
 */
export default function SplitPane({ side, sessionId, tab, focused, home, onFocus, onTab, onPromote }: SplitPaneProps) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null);
  // The per-session diff file count fleet-board already keeps for EVERY session
  // (seeded once, then diff.changed) — the same number MainTabStrip shows, with
  // no second subscription per pane.
  const diffCount = useStore((s) => (sessionId ? (s.derived.get(sessionId)?.fileCount ?? 0) : 0));

  const statusColor = session ? (STATUS_COLOR[session.status] ?? 'var(--text-dim)') : 'var(--text-dim)';

  return (
    <section
      onClick={onFocus}
      className={focused ? 'split-pane split-pane--focused' : 'split-pane'}
      data-side={side}
    >
      {/* header */}
      <div className="split-pane__header">
        {/* FR-6: the 2px accent top rule — the focus signal, flush to the card's
            top edge. Rendered unconditionally and hidden by CSS on the unfocused
            pane, so the header's geometry never shifts when focus moves. */}
        <span className="split-pane__rule" />
        <StatusDot color={statusColor} size={6} pulsing={!!session && statusPulses(session.status)} />
        <span className="split-pane__name truncate" title={session?.name}>
          {session?.name ?? 'no session'}
        </span>
        {focused ? (
          // The accent chip carries the focus signal in TEXT as well as colour
          // (design §Accessibility) — the rule must not be the only cue.
          <span className="split-pane__focus-chip">focus</span>
        ) : (
          session && (
            <span className="split-pane__status" style={{ color: statusColor }}>
              {STATUS_LABEL[session.status] ?? session.status}
            </span>
          )
        )}
        <span className="app-flex-spacer" />
        {session && <span className="split-pane__ctx">{formatContextTokens(session.contextUsedTokens)}</span>}
        {/* stopPropagation: the pane's own click handler would otherwise re-focus
            this side AFTER unsplit() has already reset focusedSide. */}
        <button
          type="button"
          className="split-pane__promote"
          title="Expand to full width"
          onClick={(e) => {
            e.stopPropagation();
            onPromote();
          }}
        >
          <Maximize2 size={12} strokeWidth={1.75} />
        </button>
      </div>

      {/* tab strip — a SUB level: sentence-case, no track, no accent underline */}
      <div className="split-pane__tabs">
        {TABS.map((t) => (
          <span
            key={t.id}
            onClick={() => onTab(t.id)}
            className={t.id === tab ? 'split-tab split-tab--on' : 'split-tab'}
          >
            {t.label}
            {/* FR-4: the same count, scoped to THIS pane's session. The badge is
                the one place the unfocused pane may carry colour. */}
            {t.id === 'diff' && diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
          </span>
        ))}
      </div>

      {/* body */}
      <div className="split-pane__body">
        {!session ? (
          <EmptyPaneMessage>select a session</EmptyPaneMessage>
        ) : tab === 'session' ? (
          <ConversationView key={session.id} sessionId={session.id} inert={!focused} onFocusRequest={onFocus} />
        ) : tab === 'diff' ? (
          <DiffView key={session.id} sessionId={session.id} />
        ) : (
          // FR-5/FR-6: the keyboard belongs to ONE pane at a time — the focused
          // one. Otherwise ⌘T opens a shell in both sessions at once, and the
          // unfocused pane's terminal grabs the caret at mount, landing
          // keystrokes in the wrong session's PTY.
          <ShellTabView key={session.id} sessionId={session.id} home={home} paneFocused={focused} />
        )}
      </div>
    </section>
  );
}

import { Maximize2, Plus, X } from 'lucide-react';
import type { SessionId } from '../../contract/common';
import { formatContextTokens } from '../../contract/conversation-view';
import { isBusyStatus, STATUS_COLOR, STATUS_LABEL, statusPulses } from '../../contract/fleet-board';
import ConversationView from '../features/conversation/ConversationView';
import DiffView from '../features/diff/DiffView';
import type { PaneTab } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { BadgePill } from '../ui/BadgePill';
import { StatusDot } from '../ui/StatusDot';
import EmptyPaneMessage from './EmptyPaneMessage';
import ShellTabView from './ShellTabView';

export interface SplitPaneProps {
  /** 0-based. Rendered 1-based in the grid chrome (FR-7) and named by ⌘<n>. */
  index: number;
  sessionId: SessionId | null;
  tab: PaneTab;
  focused: boolean;
  /**
   * split-by-4 FR-9: the turn-5d chrome. At three panes and up a pane is ONE
   * surface — no tab strip, transcript only — and its footer carries the state
   * instead of a composer.
   */
  dense: boolean;
  home: string;
  onFocus: () => void;
  onTab: (tab: PaneTab) => void;
  /** ⤢ — FR-16: leave split, promoting this pane to the single main pane. */
  onPromote: () => void;
  /** ✕ — FR-17: drop this pane; the grid compacts. Absent ⇒ not closable. */
  onClose?: () => void;
  /** FR-11: promote this pane onto DIFF. Only offered on a settled pane. */
  onReviewDiff?: () => void;
  /**
   * Explicit grid placement. The resizable grid interleaves gutter tracks with
   * the pane tracks, which defeats auto-placement above two panes — see
   * `paneGridArea`. Absent ⇒ the grid places this pane itself.
   */
  area?: { gridColumn: string; gridRow: string };
}

const TABS: readonly { id: PaneTab; label: string }[] = [
  { id: 'session', label: 'Session' },
  { id: 'diff', label: 'Diff' },
  { id: 'shell', label: 'Shell' },
];

/**
 * split-by-4 FR-7..FR-11 — one main pane: its own header (index, status dot,
 * name, `focus` chip or status label, context tokens, ⤢ and ✕), and either the
 * turn-5b Session/Diff/Shell strip (`dense: false`) or the turn-5d single
 * surface (`dense: true`).
 *
 * Deliberately NOT `MainTabStrip` + `MainPaneBody`: a pane carries a *sub*-level
 * strip (sentence-case text tabs, no segmented track) and only the three tabs
 * FR-20 allows, so reusing the shell's own strip would read as two competing
 * top-level chromes.
 */
export default function SplitPane({
  index,
  sessionId,
  tab,
  focused,
  dense,
  home,
  onFocus,
  onTab,
  onPromote,
  onClose,
  onReviewDiff,
  area,
}: SplitPaneProps) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null);
  // The per-session diff file count fleet-board already keeps for EVERY session
  // (seeded once, then diff.changed) — the same number MainTabStrip shows, with
  // no second subscription per pane.
  const diffCount = useStore((s) => (sessionId ? (s.derived.get(sessionId)?.fileCount ?? 0) : 0));

  const statusColor = session ? (STATUS_COLOR[session.status] ?? 'var(--text-dim)') : 'var(--text-dim)';
  // FR-11: "finished" is the footer state that offers a diff and a close — a
  // session with no turn in flight. isBusyStatus covers the two parked states
  // too, so a pane waiting on an approval keeps the `⌘<n> to focus` hint.
  const settled = !!session && !isBusyStatus(session.status);

  return (
    <section
      onClick={onFocus}
      style={area}
      className={
        [
          'split-pane',
          focused ? 'split-pane--focused' : null,
          dense ? 'split-pane--dense' : null,
        ]
          .filter(Boolean)
          .join(' ')
      }
      data-pane={index}
    >
      {/* header */}
      <div className="split-pane__header">
        {/* FR-10: the 2px accent top rule — the focus signal, flush to the card's
            top edge. Rendered unconditionally and hidden by CSS on the unfocused
            pane, so the header's geometry never shifts when focus moves. */}
        <span className="split-pane__rule" />
        {/* FR-7: the pane number, so `⌘<n>` in the footer and the status bar has
            something on screen to point at. Only in the grid — at two panes the
            positions themselves are the names (left / right). */}
        {dense && <span className="split-pane__index">{index + 1}</span>}
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
        {/* stopPropagation on both: the pane's own click handler would otherwise
            re-focus this pane AFTER the action has already moved focus. */}
        {/* An EMPTY grid pane has no footer to carry `close pane ✕` (that lives
            in the transcript's composer slot), so its close sits here — a pane
            you opened by mistake must be closable without leaving the grid. */}
        {dense && !session && onClose && (
          <button
            type="button"
            className="split-pane__promote"
            title="Close this pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
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

      {/* tab strip — a SUB level: sentence-case, no track, no accent underline.
          FR-9: the grid chrome has none; a pane there is one surface. */}
      {!dense && (
        <div className="split-pane__tabs">
          {TABS.map((t) => (
            <span
              key={t.id}
              onClick={() => onTab(t.id)}
              className={t.id === tab ? 'split-tab split-tab--on' : 'split-tab'}
            >
              {t.label}
              {/* FR-8: the same count, scoped to THIS pane's session. The badge is
                  the one place an unfocused pane may carry colour. */}
              {t.id === 'diff' && diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
            </span>
          ))}
        </div>
      )}

      {/* body */}
      <div className="split-pane__body">
        {!session ? (
          <EmptyPaneBody index={index} />
        ) : dense || tab === 'session' ? (
          <ConversationView
            key={session.id}
            sessionId={session.id}
            inert={!focused}
            onFocusRequest={onFocus}
            inertFooter={
              dense ? (
                <PaneFooter
                  index={index}
                  settled={settled}
                  diffCount={diffCount}
                  onFocus={onFocus}
                  onReviewDiff={onReviewDiff}
                  onClose={onClose}
                />
              ) : undefined
            }
          />
        ) : tab === 'diff' ? (
          <DiffView key={session.id} sessionId={session.id} />
        ) : (
          // FR-12: the keyboard belongs to ONE pane at a time — the focused one.
          // Otherwise ⌘T opens a shell in both sessions at once, and the
          // unfocused pane's terminal grabs the caret at mount, landing
          // keystrokes in the wrong session's PTY.
          <ShellTabView key={session.id} sessionId={session.id} home={home} paneFocused={focused} />
        )}
      </div>
    </section>
  );
}

/**
 * FR-15 — a pane with no session yet. This is what splitting a project that
 * holds a single session gives you, so it has to say what to do about it rather
 * than reading as a pane that failed to load: pick a session on the left, or
 * start one here.
 */
function EmptyPaneBody({ index }: { index: number }) {
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  return (
    <EmptyPaneMessage>
      {/* `.empty-pane` centers a single ROW; this stacks inside it. */}
      <div className="split-pane__empty">
        pane {index + 1} is empty
        <div className="split-pane__empty-hint">pick a session on the left, or</div>
        {/* Deliberately NOT stopPropagation, unlike ⤢/✕/Review diff: the click
            must also reach the pane's own handler so this pane takes focus,
            which is what routes the created session here (App's onCreated →
            FR-19). */}
        <button type="button" className="split-pane__empty-new" onClick={() => setNewSessionOpen(true)}>
          <Plus size={12} strokeWidth={2} />
          New session
        </button>
      </div>
    </EmptyPaneMessage>
  );
}

/**
 * FR-11 — the grid chrome's footer on an UNFOCUSED pane. One composer on screen,
 * so a keystroke is never ambiguous (design §Notes): a settled pane offers its
 * diff and a close, everything else says which key focuses it.
 */
function PaneFooter({
  index,
  settled,
  diffCount,
  onFocus,
  onReviewDiff,
  onClose,
}: {
  index: number;
  settled: boolean;
  diffCount: number;
  onFocus: () => void;
  onReviewDiff?: () => void;
  onClose?: () => void;
}) {
  const stop = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };
  return (
    <div className="pane-footer" onClick={onFocus}>
      {settled && onReviewDiff ? (
        <button type="button" className="pane-footer__diff" onClick={stop(onReviewDiff)}>
          Review diff
          {diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
        </button>
      ) : (
        <>
          <span className="pane-footer__arrow">›</span>
          <span className="pane-footer__hint">
            <span className="app-key">⌘{index + 1}</span> to focus and type
          </span>
        </>
      )}
      <span className="app-flex-spacer" />
      {onClose && (
        <button type="button" className="pane-footer__close" title="Close this pane" onClick={stop(onClose)}>
          close pane <X size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

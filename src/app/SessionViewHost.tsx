import { memo, useMemo, useState } from 'react';
import type { SessionId } from '../../contract/common';
import ConversationView from '../features/conversation/ConversationView';
import { useStore } from '../lib/store';
import type { HostedTab } from './appShell';
import { MRU_CAP, mruAdvance, mruPrune } from './session-mru';
import './session-host.css';
import ShellTabView from './ShellTabView';

export interface SessionViewHostProps {
  /** The pane's session — `null` while nothing is selected. */
  sessionId: SessionId | null;
  /** Which hosted body this pane is showing right now. */
  tab: HostedTab;
  home: string;
  /** What a tool row's `shell ↗` does — switch THIS pane's tab to SHELL. */
  onOpenShell: () => void;
}

/** Joins the fleet's ids into one primitive — see `liveKey` below. NUL is the
 *  separator because no session id can contain one (uuid-v4, CLAUDE.md
 *  §Conventions), so no id can forge a split. */
const SEP = '\u0000';

/**
 * The main pane's persistent host for the two bodies that are expensive to
 * build: the SESSION transcript and the SHELL terminals.
 *
 * Same shape as App.tsx's panel host, for the same reason: rendered
 * unconditionally and hidden with `display: none`, never unmounted by a tab
 * switch. It goes further in one way — it holds the last `MRU_CAP` SESSIONS
 * too, not just the current one, so `session A → session B → session A` no
 * longer re-runs hydration (up to 200 blocks over IPC, then a full markdown
 * re-parse) or destroys and replays every xterm.
 *
 * What that changes for the views themselves: a hidden `ConversationView` stays
 * subscribed, so it takes a `visible` prop and gates its delta coalescer on it
 * (useConversationTranscript) rather than scheduling animation frames for a
 * subtree nobody can see. A hidden `ShellTabView` must also give up the
 * keyboard — `visible` false ⇒ no ⌘T/⌘W/⌃⇥ handler and no terminal focus.
 *
 * The list is component state, deliberately NOT a store slice: each pane holds
 * what its own user visited, and one shared list would let a second pane evict
 * the first pane's transcript.
 */
export default function SessionViewHost({ sessionId, tab, home, onOpenShell }: SessionViewHostProps) {
  // Stable BY VALUE: this string changes only when the fleet's id set does, so
  // the host never re-renders on the status/usage churn of a session it holds.
  // Subscribing to `s.sessions` itself would re-render every held transcript on
  // every event of every session — the cost this host exists to remove.
  const liveKey = useStore((s) => s.sessions.map((session) => session.id).join(SEP));
  const liveIds = useMemo(() => (liveKey === '' ? [] : liveKey.split(SEP)), [liveKey]);

  // Derived-from-props state (React's "adjusting state during render"): the
  // list has to include the new session in the SAME pass that reveals it, or
  // the pane paints empty for a frame on every switch. Both writes are
  // conditional on an actual change, and both helpers hand back the same
  // reference when nothing moved — so this settles after one pass.
  const [held, setHeld] = useState<readonly string[]>([]);
  const nextHeld = mruPrune(mruAdvance(held, sessionId, MRU_CAP), liveIds);
  if (nextHeld !== held) setHeld(nextHeld);

  // Shells are held LAZILY — a session enters this list the first time its
  // SHELL tab is actually shown. Mounting `ShellTabView` is not free of side
  // effects: its `shell_ensure` is create-if-none, so holding one per MRU entry
  // would spawn a PTY for every session the user merely looked at. Pruned
  // against the transcript list, so a session that falls out of the MRU gives
  // up its terminals too and mounts them lazily again if it comes back.
  const [shells, setShells] = useState<readonly string[]>([]);
  const nextShells = mruPrune(mruAdvance(shells, tab === 'shell' ? sessionId : null, MRU_CAP), nextHeld);
  if (nextShells !== shells) setShells(nextShells);

  // A `display: none` element generates no flex item, so the host takes no
  // space in `.app-main-section`'s column while the pane is showing something
  // else (OVERVIEW, DIFF, an agent tab) — MainPaneBody's branch keeps the cell.
  const showing = tab !== null && sessionId !== null;

  return (
    // eslint-disable-next-line no-restricted-syntax -- runtime-computed visibility, per CLAUDE.md's inline-style exception (same pattern as App.tsx's panel host)
    <div className="session-host" style={{ display: showing ? undefined : 'none' }}>
      {nextHeld.map((id) => (
        <HeldConversation
          key={id}
          sessionId={id}
          visible={tab === 'session' && id === sessionId}
          onOpenShell={onOpenShell}
        />
      ))}
      {nextShells.map((id) => (
        <HeldShell key={id} sessionId={id} home={home} visible={tab === 'shell' && id === sessionId} />
      ))}
    </div>
  );
}

/**
 * One held transcript. Memoized so a host re-render (the fleet gaining or
 * losing a session, a switch between two OTHER held sessions) stops at this
 * boundary instead of re-rendering three transcripts — the props are a string,
 * a boolean and the caller's stable `onOpenShell` callback, so the shallow
 * compare is exact.
 */
const HeldConversation = memo(function HeldConversation({
  sessionId,
  visible,
  onOpenShell,
}: {
  sessionId: string;
  visible: boolean;
  onOpenShell: () => void;
}) {
  return (
    // eslint-disable-next-line no-restricted-syntax -- runtime-computed visibility (see the host above)
    <div className="session-host__slot" style={{ display: visible ? undefined : 'none' }}>
      <ConversationView sessionId={sessionId} visible={visible} onOpenShell={onOpenShell} />
    </div>
  );
});

/** One held SHELL tab — the sub-tab strip, its terminals and the footer. */
const HeldShell = memo(function HeldShell({
  sessionId,
  home,
  visible,
}: {
  sessionId: string;
  home: string;
  visible: boolean;
}) {
  return (
    // eslint-disable-next-line no-restricted-syntax -- runtime-computed visibility (see the host above)
    <div className="session-host__slot" style={{ display: visible ? undefined : 'none' }}>
      {/* `paneFocused` is what owns the keyboard (ShellTabView): a hidden shell
          must not run the ⌘T/⌘W/⌃⇥ document listener, and its terminals must
          neither take the caret nor fit against a zero-height container. */}
      <ShellTabView sessionId={sessionId} home={home} visible={visible} paneFocused={visible} />
    </div>
  );
});

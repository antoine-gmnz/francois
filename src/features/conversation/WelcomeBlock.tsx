// The SESSION tab's welcome header — what stands in for an empty transcript.
//
// Layout is Figma "Graphite & Signal" screen 11 (Session / Welcome, 136:5306):
// a heading naming the session, one subline (model · account · where it works),
// then two filled context cards side by side — "This repo" (its CLAUDE.md and
// where HEAD sits) and "Recent here" (the sessions that finished in this repo).
//
// The subline and the recent card come from the store. The repo card's two
// facts do not, so they come from one read-only probe (project_repo_brief,
// contract/session-welcome.ts) fired once on mount — the header only exists
// while the transcript is empty, so there is nothing to keep live. A failed or
// pending probe simply renders fewer lines; it is never an error surface.
//
// The mock's "Try" suggestion list is not rendered: its prompts are
// repo-specific and nothing in the app derives them.

import { useEffect, useState } from 'react';
import type { RepoBrief } from '../../../contract/session-welcome';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { projectRepoBrief } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { ProfileChip } from '../profiles/ProfileChip';
import { claudeMdSegments, recentInRepo, welcomeSubline, workingOnSegments, type Segment } from './welcome';
import './welcome.css';

export interface WelcomeBlockProps {
  sessionId: string;
}

export default function WelcomeBlock({ sessionId }: WelcomeBlockProps) {
  const meta = useStore((s) => s.sessions.find((session) => session.id === sessionId) ?? null);
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);

  const [brief, setBrief] = useState<RepoBrief | null>(null);
  useEffect(() => {
    // Per-run guard rather than useMounted: the deps key on sessionId, which can
    // change without this component unmounting, and a stale repo's facts must
    // never land on the session that replaced it.
    let live = true;
    void projectRepoBrief(sessionId).then((res) => {
      if (live && res.ok) setBrief(res.data);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (!meta) return null;

  const account = accounts.find((a) => a.id === meta.accountId);
  const subline = welcomeSubline({
    model: meta.model.label,
    account: account?.email ?? (account && !account.builtIn ? account.label : undefined),
    worktree: meta.worktree,
    branch: brief?.git?.branch,
  });
  const working = workingOnSegments(brief?.git);
  const recent = recentInRepo(sessions, meta);
  const cwd = displayWslCwd(meta.cwd) ?? meta.cwd;

  return (
    <div className="welcome">
      <div className="welcome__intro">
        <h1 className="welcome__title">Start {meta.name}</h1>
        <div className="welcome__subline" title={cwd}>
          {subline && <span className="welcome__subline-text">{subline}</span>}
          {/* session-profiles FR-22: the one accented chip this view gets. */}
          {meta.profile && <ProfileChip profile={meta.profile} accent />}
        </div>
      </div>

      <div className="welcome__cards">
        <section className="welcome__card">
          <h2 className="welcome__card-head">
            <Icon name="doc" size={14} />
            This repo
          </h2>
          <p className="welcome__line">
            <Sentence segments={claudeMdSegments(brief?.claudeMd)} />
          </p>
          {working && (
            <p className="welcome__line">
              <Sentence segments={working} />
            </p>
          )}
        </section>

        {recent.length > 0 && (
          <section className="welcome__card">
            <h2 className="welcome__card-head">
              <Icon name="clock" size={14} />
              Recent here
            </h2>
            {recent.map((entry) => (
              <p key={entry.id} className="welcome__line welcome__line--nowrap" title={entry.name}>
                <span className="welcome__strong">{entry.name}</span>
                <span className={entry.done ? undefined : 'welcome__failed'}> · {entry.phrase}</span>
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** A header sentence: plain runs, with the noun it is about in the brighter tone. */
function Sentence({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.strong ? (
          <span key={i} className="welcome__strong">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

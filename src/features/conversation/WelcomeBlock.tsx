// The SESSION tab's welcome header — what stands in for an empty transcript.
//
// Layout is the redesign mock's framed welcome block ("Francois Redesign.dc.html",
// the 3a shell): a legend-framed panel carrying the app version, split into two
// columns by a hairline. Left is who you are and what this session runs on — the
// mark, the model, the account, the branch, the path. Right is what the repo
// looks like: its CLAUDE.md, where HEAD sits, and the sessions that finished here
// before.
//
// Everything the left column states is already in the store. The right column's
// two facts are not, so they come from one read-only probe (project_repo_brief,
// contract/session-welcome.ts) fired once on mount — the header only exists
// while the transcript is empty, so there is nothing to keep live. A failed or
// pending probe simply renders fewer lines; it is never an error surface.

import { useEffect, useState } from 'react';
import type { RepoBrief } from '../../../contract/session-welcome';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { projectRepoBrief } from '../../lib/api';
import { useAppVersion } from '../../lib/hooks/useAppVersion';
import { useStore } from '../../lib/store';
import { Logo } from '../../ui/Logo';
import { ProfileChip } from '../profiles/ProfileChip';
import { claudeMdSegments, identityParts, recentInRepo, workingOnSegments, type Segment } from './welcome';

export interface WelcomeBlockProps {
  sessionId: string;
}

export default function WelcomeBlock({ sessionId }: WelcomeBlockProps) {
  const meta = useStore((s) => s.sessions.find((session) => session.id === sessionId) ?? null);
  const sessions = useStore((s) => s.sessions);
  const accounts = useStore((s) => s.accounts);
  const appVersion = useAppVersion();

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
  // session-worktree: an isolated session knows its own branch without asking,
  // so the identity line is right from the first paint and only sharpens when
  // the probe lands.
  const branch = brief?.git?.branch ?? meta.worktree?.branch;
  const identity = identityParts({
    model: meta.model.label,
    account: account?.email ?? (account && !account.builtIn ? account.label : undefined),
    branch,
  });
  const working = workingOnSegments(brief?.git);
  const recent = recentInRepo(sessions, meta);

  return (
    <div className="welcome">
      <span className="welcome__legend">{appVersion ? `Francois v${appVersion}` : 'Francois'}</span>

      <div className="welcome__identity">
        <div className="welcome__greeting">Welcome back</div>
        {/* 9a: down from 56 — the block tightened around it. */}
        <Logo size={47} title="Francois" />
        <div className="welcome__meta">
          {identity.length > 0 && <span>{identity.join(' · ')}</span>}
          {/* session-profiles FR-22: the ONE acid chip this view gets — the
              focused session's own welcome header, never the sidebar/fleet card. */}
          {meta.profile && <ProfileChip profile={meta.profile} accent />}
          <span className="welcome__cwd">{displayWslCwd(meta.cwd) ?? meta.cwd}</span>
        </div>
      </div>

      <span className="welcome__rule" />

      <div className="welcome__repo">
        <section className="welcome__section">
          <h2 className="welcome__heading">This repo</h2>
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
          <>
            <span className="welcome__hr" />
            <section className="welcome__section">
              <h2 className="welcome__heading">Recent in this repo</h2>
              {recent.map((entry) => (
                <div key={entry.id} className="welcome__recent">
                  <span className={entry.done ? 'welcome__mark' : 'welcome__mark welcome__mark--error'}>
                    {entry.done ? '✓' : '✕'}
                  </span>
                  <span className="welcome__recent-name" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="welcome__age">{entry.age}</span>
                </div>
              ))}
            </section>
          </>
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

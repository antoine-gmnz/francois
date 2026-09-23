// The Changes panel's pull-request card: shown only while the session's branch
// has an open (or draft) PR. Status, the merge button (the GitHub page's own
// confirm, MergeModal), and two ways out — the PR on github.com, and the same
// PR on Francois' GitHub page.

import { useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { SidePanelLabel } from '../../ui/SidePanel';
import { openOnGithub } from './actions';
import { selectPullInTab } from './github-tab-state';
import { MergeModal } from './MergeModal';
import { canMergeInApp, checkRollupChip, mergeButtonLabel, pullStateChip, pullStateIcon } from './pulls';
import { mergeableSummary } from './session-pull';
import { useSessionPull } from './useSessionPull';
import './pulls.css';
import './session-pull.css';

export function SessionPullCard({ session }: { session: SessionMeta }): JSX.Element | null {
  const { pull, refresh } = useSessionPull(session.id, session.cwd);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const [merging, setMerging] = useState(false);

  if (!pull) return null;

  const cwd = session.cwd;
  const state = pullStateChip(pull.state);
  const checks = checkRollupChip(pull.checks);
  const open = pull.state === 'open' || pull.state === 'draft';
  const mergeable = open ? mergeableSummary(pull.mergeable) : null;

  const openInFrancois = () => {
    selectPullInTab(pull.number);
    setFocusedPane('main');
    setMainTab('github');
  };

  return (
    <section className="session-pull" aria-label={`Pull request #${pull.number}`}>
      <SidePanelLabel>Pull request</SidePanelLabel>
      <div className="session-pull__title" title={pull.title}>
        <Icon name={pullStateIcon(pull.state)} size={13} />
        <span className="session-pull__number">#{pull.number}</span>
        <span className="truncate">{pull.title}</span>
      </div>
      <div className="session-pull__status">
        <span className={`pull-state-chip pull-state-chip--${state.tone}`}>{state.label}</span>
        {checks && <span className={`session-pull__note session-pull__note--${checks.tone}`}>{checks.label}</span>}
        {mergeable && <span className={`session-pull__note session-pull__note--${mergeable.tone}`}>{mergeable.text}</span>}
      </div>
      <div className="session-pull__actions">
        {pull.state === 'open' && (
          <Button
            variant="primary"
            size="sm"
            title={canMergeInApp(pull) ? `Merge #${pull.number} into ${pull.base}` : 'Not mergeable here — opens the PR on GitHub'}
            onClick={() => (canMergeInApp(pull) ? setMerging(true) : void openOnGithub(cwd, pull.url))}
          >
            {mergeButtonLabel(pull.mergeable)}
          </Button>
        )}
        <Button variant="ghost" size="sm" title="Open the pull request on github.com" onClick={() => void openOnGithub(cwd, pull.url)}>
          GitHub <Icon name="external" size={11} />
        </Button>
        <Button variant="ghost" size="sm" title="Open in Francois' GitHub page" onClick={openInFrancois}>
          Details
        </Button>
      </div>
      {merging && (
        <MergeModal cwd={cwd} pull={pull} onClose={() => setMerging(false)} onMerged={() => refresh(pull.number)} />
      )}
    </section>
  );
}

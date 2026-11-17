// claude-project-health — the two pinned diagnostics above the transcript:
// an untrusted folder whose allow rules Claude Code is ignoring, and Cohorte's
// guard hook whose interpreter Francois cannot find. Same geometry as
// WorktreeNotice/ResumeFailBanner; styles in conversation.css.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import './conversation.css';
import {
  allowRulesPhrase,
  dismissGuardBanner,
  dismissTrustBanner,
  guardBannerVisible,
  isGuardBannerDismissed,
  isTrustBannerDismissed,
  trustBannerVisible,
  trustFolder,
} from './project-health';
import { useProjectHealth } from './useProjectHealth';

export default function ProjectHealthBanners({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const { health, refresh } = useProjectHealth(sessionId, visible);
  const [trustDismissed, setTrustDismissed] = useState(() => isTrustBannerDismissed(sessionId));
  const [guardDismissed, setGuardDismissed] = useState(() => isGuardBannerDismissed(sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!health) return null;
  const { trust, guard } = health;

  const onTrust = async () => {
    setBusy(true);
    setError(null);
    try {
      setError(await trustFolder(sessionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <>
      {trustBannerVisible(health, trustDismissed) && (
        <div role="status" className="health-banner health-banner--trust">
          <div className="health-banner__text">
            Claude Code ignores this project&apos;s {allowRulesPhrase(trust.allowRuleCount)} until the folder is
            trusted, so commands they cover will still ask for approval.
            <div className="health-banner__key" title={trust.key}>
              {trust.key}
            </div>
            <div className="health-banner__actions">
              <Button size="sm" busy={busy} onClick={() => void onTrust()}>
                Trust this folder
              </Button>
              <span className="health-banner__hint">
                or run <code>claude</code> once in <code>{trust.key}</code> and accept
              </span>
            </div>
            {error && <div className="health-banner__error">{error}</div>}
          </div>
          <button
            type="button"
            className="health-banner__dismiss"
            title="dismiss"
            onClick={() => {
              dismissTrustBanner(sessionId);
              setTrustDismissed(true);
            }}
          >
            ✕
          </button>
        </div>
      )}
      {guardBannerVisible(health, guardDismissed) && (
        <div role="alert" className="health-banner health-banner--guard">
          <div className="health-banner__text">
            Cohorte&apos;s guard hook needs <code>{guard.interpreterMissing}</code>, which Francois can&apos;t find on the
            PATH it gives Claude Code. Every Bash, Edit, Write and Agent call will be refused until it is installed
            or on your login-shell PATH.
          </div>
          <button
            type="button"
            className="health-banner__dismiss"
            title="dismiss for this session"
            onClick={() => {
              dismissGuardBanner(sessionId);
              setGuardDismissed(true);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

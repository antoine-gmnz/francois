// cloud-sessions FR-14 — pane [1]'s adopt action, beside "new session".
//
// Icon-only and quiet on purpose: adopting is the rarer of the two starts, so
// it sits in design 7a's roster-header act cluster next to the accent `+`,
// matching .sidebar__act's geometry while the accent stays with new-session.

import { CloudDownload } from 'lucide-react';
import { useStore } from '../../lib/store';
import './cloud-sessions.css';

export function AdoptCloudButton(): JSX.Element {
  const setAdoptCloudOpen = useStore((s) => s.setAdoptCloudOpen);
  return (
    <button
      type="button"
      className="cloud-adopt-button"
      title="Adopt a session you started on claude.ai or your phone"
      aria-label="Adopt cloud session"
      onClick={() => setAdoptCloudOpen(true)}
    >
      {/* Tone comes from the class — the icon inherits currentColor. */}
      <CloudDownload size={13} strokeWidth={1.75} />
    </button>
  );
}

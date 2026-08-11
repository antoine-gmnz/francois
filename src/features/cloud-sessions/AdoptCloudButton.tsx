// cloud-sessions FR-14 — pane [1]'s adopt action, beside "New session".
//
// Compact on purpose: adopting is the rarer of the two starts, so it takes the
// narrow half of the footer row and the primary keeps its width (the roster
// narrows to 238px in split — a second full-width button would crowd it).

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
      <CloudDownload size={14} />
    </button>
  );
}

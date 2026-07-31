import type { DropOverlayState } from './attachments';
import './conversation.css';

// session-attachments design §2 — the SESSION tab drop target. Decorative
// (`aria-hidden`): every drop has a keyboard-reachable equivalent in the
// composer's `+` button. Rendered inside `.conv-root`, so it covers the
// transcript + composer and never the sidebar or the status bar.

export default function DropOverlay({ state }: { state: DropOverlayState }) {
  if (state === 'hidden') return null;
  const rejecting = state === 'rejecting';
  return (
    <div className={rejecting ? 'drop-overlay drop-overlay--rejecting' : 'drop-overlay'} aria-hidden="true">
      <div className="drop-overlay__frame">
        <div className="drop-overlay__label">{rejecting ? "Folders can't be attached" : 'Drop files to attach'}</div>
        <div className="drop-overlay__hint">images become chips · other files become @paths</div>
      </div>
    </div>
  );
}

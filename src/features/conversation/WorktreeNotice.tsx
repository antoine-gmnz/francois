// session-worktree FR-14 — pinned bare-checkout notice, rendered above the
// transcript so it never scrolls away. A live region on first render (spec §8
// notes). Dismissal is per-session and persisted in localStorage, so once
// dismissed the banner never returns for that session.

import type { SessionWorktree } from '../../../contract/common';
import { worktreeBaseLine, worktreeFetchWarningLine } from '../sessions/worktree';

export default function WorktreeNotice({ worktree, onDismiss }: { worktree: SessionWorktree; onDismiss: () => void }) {
  const fetchWarning = worktreeFetchWarningLine(worktree);
  const baseLine = worktreeBaseLine(worktree);
  return (
    <div role="status" className="worktree-notice">
      <div className="worktree-notice__text">
        this session runs in an isolated git worktree — no dependencies were installed, and
        local-scope config (<code>.claude/settings.local.json</code>, local <code>.mcp.json</code>) was not
        carried over, so permission rules and MCP servers may differ from the parent checkout.
        {baseLine && <div className="worktree-notice__base">{baseLine}</div>}
        {fetchWarning && <div className="worktree-notice__warning">{fetchWarning}</div>}
      </div>
      <span onClick={onDismiss} className="worktree-notice__dismiss" title="dismiss">
        ✕
      </span>
    </div>
  );
}

// code-editor-workspace FR-1 — the 44px activity bar left of the sidebar (Figma 52):
// Explorer, Search, Source control and Extensions (code-editor-vsx FR-6) swap the sidebar (re-clicking the shown one
// collapses it), Problems toggles the panel, Settings
// (pinned to the foot) opens the app Settings.

import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { useStore } from '../../lib/store';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { problemCounts } from './problems';
import { useRootProblems } from './useRootProblems';
import { useWorkspaceStore } from './workspaceStore';
import './code-workspace.css';

const NO_CHANGES: Record<string, unknown> = {};

function Badge({ n, tone }: { n: number; tone: 'attention' | 'danger' | 'neutral' }): JSX.Element | null {
  if (n <= 0) return null;
  return <span className={`code-activity__badge code-activity__badge--${tone}`}>{n > 99 ? '99+' : n}</span>;
}

export default function ActivityBar(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const changes = useCodeStore((s) => s.filesByRootKey[rk]?.data?.changes ?? NO_CHANGES);
  const sidebar = useWorkspaceStore((s) => s.sidebar);
  const problems = useRootProblems(rk);
  const problemsOpen = useWorkspaceStore((s) => s.problemsOpen);
  const { pickView, toggleProblems } = useWorkspaceStore.getState();
  const changed = Object.keys(changes);
  const counts = problemCounts(problems);
  const issues = counts.errors + counts.warnings;

  return (
    <nav className="code-activity" aria-label="Code views">
      <IconButton title="Explorer" size={34} on={sidebar === 'explorer'} className="code-activity__item" onClick={() => pickView('explorer')}>
        <Icon name="folder" size={18} />
      </IconButton>
      <IconButton title="Search · ⌘⇧F" size={34} on={sidebar === 'search'} className="code-activity__item" onClick={() => pickView('search')}>
        <Icon name="search" size={18} />
      </IconButton>
      <IconButton
        title={changed.length > 0 ? `Source control — ${changed.length} changed` : 'Source control — no changes'}
        size={34}
        on={sidebar === 'changes'}
        className="code-activity__item"
        onClick={() => pickView('changes')}
      >
        <Icon name="branch" size={18} />
        <Badge n={changed.length} tone="danger" />
      </IconButton>
      <IconButton title="Extensions" size={34} on={sidebar === 'extensions'} className="code-activity__item" onClick={() => pickView('extensions')}>
        <Icon name="layers" size={18} />
      </IconButton>
      <IconButton title="Problems · ⌘⇧M" size={34} on={problemsOpen} className="code-activity__item" onClick={toggleProblems}>
        <Icon name="warn" size={18} />
        <Badge n={issues} tone={counts.errors > 0 ? 'danger' : 'neutral'} />
      </IconButton>
      <div className="code-activity__spacer" />
      <IconButton title="Settings" size={34} className="code-activity__item" onClick={() => useStore.getState().setProjectsOpen(true)}>
        <Icon name="cog" size={18} />
      </IconButton>
    </nav>
  );
}

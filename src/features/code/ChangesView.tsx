// The SOURCE CONTROL sidebar: the root's branch, then every path `git status` reports
// changed (from `editor_files`' `changes`). A modified file opens straight into Review
// against HEAD; an added/untracked one has no HEAD to compare with and opens plainly.
// Committing stays in the session's DIFF tab.

import { useMemo } from 'react';
import type { GitChange } from '../../../contract/code-editor';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { changeRows } from './changes-view';
import './code.css';
import './code-workspace.css';

const NO_CHANGES: Record<string, GitChange> = {};

export default function ChangesView(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const files = useCodeStore((s) => s.filesByRootKey[rk]);
  const changes = files?.data?.changes ?? NO_CHANGES;
  const rows = useMemo(() => changeRows(changes), [changes]);
  const branch = files?.data?.branch ?? null;

  const open = async (path: string, change: GitChange) => {
    const st = useCodeStore.getState();
    const res = await st.openFile(path);
    if (res.ok && change === 'M') st.setReview(rk, path, true);
  };

  return (
    <aside className="code-changes" aria-label="Source control">
      <div className="code-explorer__header">
        <span className="code-explorer__title">Source control</span>
        <div className="code-explorer__actions">
          <IconButton title="Refresh" size={24} className="code-explorer__action" onClick={() => void useCodeStore.getState().refreshFiles()}>
            <Icon name="refresh" size={14} />
          </IconButton>
        </div>
      </div>

      {branch && (
        <div className="code-changes__branch">
          <Icon name="branch" size={13} />
          <span>{branch}</span>
        </div>
      )}

      <div className="code-changes__section">
        <span>Changes</span>
        {rows.length > 0 && <span className="code-changes__count">{rows.length}</span>}
      </div>

      <div className="code-changes__list" role="list">
        {files?.loading && !files.data && <p className="code-tree__note">Loading changes…</p>}
        {files?.data && rows.length === 0 && <p className="code-tree__note">{branch ? 'No changes — the working tree is clean.' : 'Not a git repository.'}</p>}
        {rows.map((r) => (
          <div
            key={r.path}
            role="listitem"
            tabIndex={0}
            className={r.change === 'M' ? 'code-changes__row code-tree__row--modified' : 'code-changes__row code-tree__row--added'}
            title={r.change === 'M' ? `${r.path} — open in Review` : r.path}
            onClick={() => void open(r.path, r.change)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void open(r.path, r.change);
            }}
          >
            <Icon name="file" size={14} className="code-changes__icon" />
            <span className="code-changes__name">{r.name}</span>
            {r.dir && <span className="code-changes__dir">{r.dir}</span>}
            <span className="code-tree__letter">{r.change}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

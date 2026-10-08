// code-editor FR-4/FR-5, flow 3 — the explorer (Figma 45, left column): header,
// root picker, the tree built from `editor_files`, the truncation note, the footer.

import { useMemo, useRef, type KeyboardEvent } from 'react';
import { EDITOR_FILES_CAP } from '../../../contract/code-editor';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { buildTree, treeKeyAction, visibleRows, type TreeRow } from './file-tree';
import { openExternally, useDetectedEditor } from './open-external';
import RootPicker from './RootPicker';
import './code.css';

const EMPTY: string[] = [];

function rowClass(row: TreeRow, selected: boolean): string {
  const parts = ['code-tree__row'];
  if (selected) parts.push('code-tree__row--selected');
  if (row.change === 'M') parts.push('code-tree__row--modified');
  if (row.change === 'A') parts.push('code-tree__row--added');
  return parts.join(' ');
}

export default function Explorer(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const files = useCodeStore((s) => s.filesByRootKey[rk]);
  const expanded = useCodeStore((s) => s.expandedByRootKey[rk] ?? EMPTY);
  const selected = useCodeStore((s) => s.selectedByRootKey[rk] ?? null);
  const hint = useCodeStore((s) => s.rowHintByRootKey[rk] ?? null);
  const { toggleDir, select, openFile, refreshFiles, setGoToFileOpen } = useCodeStore.getState();
  const editor = useDetectedEditor();
  const treeRef = useRef<HTMLDivElement>(null);

  const data = files?.data ?? null;
  const tree = useMemo(() => buildTree(data?.paths ?? []), [data]);
  const rows = useMemo(() => visibleRows(tree, new Set(expanded), data?.changes ?? {}), [tree, expanded, data]);

  const act = (row: TreeRow) => {
    select(row.path);
    if (row.kind === 'dir') toggleDir(row.path);
    else void openFile(row.path);
  };

  const onKey = (e: KeyboardEvent) => {
    const action = treeKeyAction(rows, selected, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'select') select(action.path);
    else if (action.kind === 'open') void openFile(action.path);
    else toggleDir(action.path);
  };

  return (
    <aside className="code-explorer" aria-label="Explorer">
      <div className="code-explorer__header">
        <span className="code-explorer__title">Explorer</span>
        <div className="code-explorer__actions">
          <IconButton title="New file — not in this version" size={24} className="code-explorer__action" disabled>
            <Icon name="plus" size={14} />
          </IconButton>
          <IconButton title="Go to file · ⌘P" size={24} className="code-explorer__action" onClick={() => setGoToFileOpen(true)}>
            <Icon name="search" size={14} />
          </IconButton>
          <IconButton title="Refresh" size={24} className="code-explorer__action" onClick={() => void refreshFiles()}>
            <Icon name="refresh" size={14} />
          </IconButton>
        </div>
      </div>

      <RootPicker branch={data?.branch ?? null} label={data?.rootLabel ?? null} />

      <div className="code-tree" role="tree" tabIndex={0} ref={treeRef} onKeyDown={onKey}>
        {!root && <p className="code-tree__note">Register a project to browse its files.</p>}
        {files?.error && (
          <div className="code-tree__error">
            <span>{files.error.message}</span>
            <button type="button" className="code-tree__retry" onClick={() => void refreshFiles()}>
              Retry
            </button>
          </div>
        )}
        {files?.loading && !data && <p className="code-tree__note">Loading files…</p>}
        {rows.map((row) => (
          <div key={row.path}>
            <div
              role="treeitem"
              aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
              aria-selected={selected === row.path}
              className={rowClass(row, selected === row.path)}
              // eslint-disable-next-line no-restricted-syntax -- the indent is per-depth data, computed at runtime
              style={{ paddingLeft: 8 + row.depth * 14 }}
              title={row.path}
              onClick={() => {
                act(row);
                treeRef.current?.focus();
              }}
            >
              {row.kind === 'dir' ? (
                <>
                  <span className={row.expanded ? 'code-tree__chevron code-tree__chevron--open' : 'code-tree__chevron'}>
                    <Icon name="chevron-right" size={12} />
                  </span>
                  <Icon name="folder" size={14} className="code-tree__icon" />
                </>
              ) : (
                <>
                  <span className="code-tree__chevron" />
                  <Icon name="file" size={14} className="code-tree__icon" />
                </>
              )}
              <span className="code-tree__name">{row.name}</span>
              {row.changed && <span className="code-tree__dot" aria-label="contains changes" />}
              {row.change && <span className="code-tree__letter">{row.change}</span>}
            </div>
            {hint?.path === row.path && (
              <div
                className="code-tree__hint"
                // eslint-disable-next-line no-restricted-syntax -- indented one level under its row, computed at runtime
                style={{ paddingLeft: 8 + (row.depth + 1) * 14 }}
              >
                <span>{hint.code === 'EDITOR_BINARY' ? 'Binary file — not opened here.' : 'Too large to open here.'}</span>
                {editor && root && (
                  <button type="button" className="code-tree__retry" onClick={() => void openExternally(root, editor, row.path)}>
                    Open in {editor.label}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {data?.truncated && (
          <p className="code-tree__note">Showing the first {EDITOR_FILES_CAP.toLocaleString('en-US')} files only.</p>
        )}
      </div>

      <div className="code-explorer__footer">
        <Kbd keys="⌘P" />
        <span>go to file</span>
      </div>
    </aside>
  );
}

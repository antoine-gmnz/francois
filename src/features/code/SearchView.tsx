// code-editor-workspace FR-12/FR-13 — the SEARCH sidebar (Figma 57): query with
// Aa / ab / .* toggles, replace with AB and Replace All, "files to include", the
// summary, then results grouped by file. A match opens in the focused group with the
// match selected. Replace All confirms once and skips files with unsaved edits.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorSearchFile, EditorSearchMatch, EditorSearchOptions } from '../../../contract/code-editor-workspace';
import { Icon } from '../../ui/Icon';
import { Button } from '../../ui/Button';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { matchRange, plural, replacePlan, useSearchStore } from './searchStore';
import { useWorkspaceStore } from './workspaceStore';
import './code.css';
import './code-workspace.css';

const NO_TABS: CodeTab[] = [];

function Toggle({ label, title, on, onClick }: { label: string; title: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={on ? 'code-search__toggle code-search__toggle--on' : 'code-search__toggle'} title={title} aria-label={title} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function Preview({ m }: { m: EditorSearchMatch }): JSX.Element {
  return (
    <span className="code-search__preview">
      {m.preview.slice(0, m.previewStart)}
      <strong className="code-search__match">{m.preview.slice(m.previewStart, m.previewEnd)}</strong>
      {m.preview.slice(m.previewEnd)}
    </span>
  );
}

function FileResult({ file, collapsed }: { file: EditorSearchFile; collapsed: boolean }): JSX.Element {
  const cut = file.path.lastIndexOf('/');
  const open = (m: EditorSearchMatch) => void useCodeStore.getState().revealRange(file.path, matchRange(m));
  return (
    <div role="treeitem" aria-expanded={!collapsed}>
      <div className="code-search__file" title={file.path} onClick={() => useSearchStore.getState().toggleCollapsed(file.path)}>
        <span className={collapsed ? 'code-tree__chevron' : 'code-tree__chevron code-tree__chevron--open'}>
          <Icon name="chevron-right" size={12} />
        </span>
        <Icon name="file" size={14} className="code-search__file-icon" />
        <span className="code-search__name">{file.path.slice(cut + 1)}</span>
        {cut > 0 && <span className="code-search__dir">{file.path.slice(0, cut)}</span>}
        <span className="code-search__count">{file.matches.length}</span>
      </div>
      {!collapsed &&
        file.matches.map((m, i) => (
          <div
            key={i}
            className="code-search__row"
            role="button"
            tabIndex={0}
            title={`Ln ${m.line}, Col ${m.column}`}
            onClick={() => open(m)}
            onKeyDown={(e) => e.key === 'Enter' && open(m)}
          >
            <Preview m={m} />
          </div>
        ))}
    </div>
  );
}

export default function SearchView(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const tabs = useCodeStore((s) => s.tabsByRootKey[rk]?.tabs ?? NO_TABS);
  const s = useSearchStore();
  const focusTick = useWorkspaceStore((w) => w.searchFocusTick);
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (root) useSearchStore.getState().syncRoot(root);
  }, [root]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const plan = useMemo(() => (s.result ? replacePlan(s.result.files, tabs) : null), [s.result, tabs]);
  const fileCount = s.result?.files.length ?? 0;
  const canReplace = !!s.result && s.result.matchCount > 0 && s.status !== 'loading';

  if (!root) return <aside className="code-search" aria-label="Search" />;

  const toggle = (o: keyof EditorSearchOptions) => s.toggleOption(root, o);

  return (
    <aside className="code-search" aria-label="Search">
      <div className="code-explorer__header">
        <span className="code-explorer__title">Search</span>
      </div>

      <div className="code-search__form">
        <div className="code-search__field">
          <input
            ref={inputRef}
            className="code-search__input"
            placeholder="Search"
            aria-label="Search"
            value={s.query}
            onChange={(e) => s.setQuery(root, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.run(root);
            }}
          />
          <Toggle label="Aa" title="Match case" on={s.options.matchCase} onClick={() => toggle('matchCase')} />
          <Toggle label="ab" title="Match whole word" on={s.options.wholeWord} onClick={() => toggle('wholeWord')} />
          <Toggle label=".*" title="Use regular expression" on={s.options.regex} onClick={() => toggle('regex')} />
        </div>
        {s.status === 'error' && s.error && (
          <p className="code-search__error" role="alert">
            {s.error}
          </p>
        )}
        <div className="code-search__replace">
          <div className="code-search__field">
            <input
              className="code-search__input"
              placeholder="Replace"
              aria-label="Replace"
              value={s.replacement}
              onChange={(e) => s.setReplacement(e.target.value)}
            />
            <Toggle label="AB" title="Preserve case" on={s.preserveCase} onClick={s.togglePreserveCase} />
          </div>
          <Button variant="secondary" size="sm" disabled={!canReplace} onClick={() => setConfirming(true)}>
            Replace All
          </Button>
        </div>
        <input
          className="code-search__input code-search__include"
          placeholder="files to include"
          aria-label="Files to include"
          value={s.include}
          onChange={(e) => s.setInclude(root, e.target.value)}
        />
      </div>

      {confirming && plan && (
        <div className="code-search__confirm" role="alertdialog" aria-label="Confirm replace">
          <span>
            Replace {plural(plan.matches, 'match')} in {plural(plan.targets.length, 'file')}?
            {plan.dirty.length > 0 && ` ${plural(plan.dirty.length, 'file')} with unsaved edits will be skipped.`}
          </span>
          <div className="code-search__confirm-actions">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={plan.targets.length === 0}
              onClick={() => {
                setConfirming(false);
                void s.replaceAll(root, tabs);
              }}
            >
              Replace
            </Button>
          </div>
        </div>
      )}
      {s.notice && (
        <div className="code-notice" role="status">
          <span>{s.notice}</span>
          <button type="button" className="code-notice__dismiss" aria-label="Dismiss" onClick={() => s.setNotice(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      <div className="code-search__results" role="tree">
        {s.result && (
          <p className="code-search__summary">
            {s.result.matchCount === 0 ? 'No results.' : `${plural(s.result.matchCount, 'result')} in ${plural(fileCount, 'file')}`}
            {s.status === 'loading' && ' · searching…'}
          </p>
        )}
        {!s.result && s.status === 'loading' && <p className="code-search__summary">Searching…</p>}
        {s.result?.truncated && <p className="code-search__summary">Showing the first results — refine the search.</p>}
        {s.result?.files.map((f) => <FileResult key={f.path} file={f} collapsed={s.collapsed.includes(f.path)} />)}
      </div>
    </aside>
  );
}

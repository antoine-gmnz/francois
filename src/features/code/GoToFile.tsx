// Flow 5 — ⌘P "Go to file": a fuzzy picker over the root's `editor_files` paths,
// recent files first on an empty query. ↑/↓ move, ⏎ opens, Esc closes.

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Modal } from '../../ui/Modal';
import { useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { rankPaths } from './fuzzy';
import './code.css';

const NONE: string[] = [];

function Highlighted({ path, indices }: { path: string; indices: number[] }): JSX.Element {
  if (indices.length === 0) return <>{path}</>;
  const hit = new Set(indices);
  return (
    <>
      {[...path].map((ch, i) =>
        hit.has(i) ? (
          <mark key={i} className="code-goto__hit">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  );
}

export default function GoToFile(): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const paths = useCodeStore((s) => s.filesByRootKey[rk]?.data?.paths ?? NONE);
  const recent = useCodeStore((s) => s.recentByRootKey[rk] ?? NONE);
  const close = () => useCodeStore.getState().setGoToFileOpen(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const ranking = useMemo(() => rankPaths(paths, query, recent), [paths, query, recent]);
  const items = ranking.items;

  const open = (path: string) => {
    close();
    void useCodeStore.getState().openFile(path);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, items.length - 1));
    else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
    else if (e.key === 'Enter' && items[cursor]) open(items[cursor].path);
    else return;
    e.preventDefault();
  };

  return (
    <Modal onClose={close} width={560} closeOnBackdropClick closeOnEscape>
      <div className="code-goto">
        <input
          className="code-goto__input"
          autoFocus
          placeholder="Go to file…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKey}
        />
        <ul className="code-goto__list" role="listbox">
          {items.length === 0 && <li className="code-goto__empty">No matching files</li>}
          {items.map((it, i) => (
            <li
              key={it.path}
              role="option"
              aria-selected={i === cursor}
              className={i === cursor ? 'code-goto__item code-goto__item--on' : 'code-goto__item'}
              onMouseEnter={() => setCursor(i)}
              onClick={() => open(it.path)}
            >
              <span className="code-goto__name">
                <Highlighted path={it.path} indices={it.indices} />
              </span>
              {query === '' && ranking.recent.includes(it.path) && <span className="code-goto__tag">recent</span>}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// code-editor-workspace FR-11 — quick open (Figma 56): a 600px palette dropping from
// the top of the editor area over a dimmed editor, replacing code-editor's Go to file
// modal. Files (RECENTLY OPENED, FILES), `:N[:C]` go to line, `@` symbols of the
// focused group's file. ⏎ opens in the focused group, ⌘⏎ in the other one.

import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { groupsOfRoot, useCodeStore } from './codeStore';
import { rootKey } from './editor-root';
import { groupEditor } from './group-editors';
import { documentSymbols } from './monaco-symbols';
import { parseQuickQuery, quickOpenSections, rankSymbols, type FileRow, type RankedSymbol } from './quick-open';
import { flattenSymbols, type FlatSymbol } from './symbols';
import './code-workspace.css';

const NONE: string[] = [];

function Hits({ text, hits }: { text: string; hits: readonly number[] }): JSX.Element {
  if (hits.length === 0) return <>{text}</>;
  const on = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) =>
        on.has(i) ? (
          <mark key={i} className="code-quick__hit">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  );
}

type Item = { kind: 'file'; row: FileRow } | { kind: 'line'; line: number; column: number | null } | { kind: 'symbol'; ranked: RankedSymbol };

/** The focused group's symbols, fetched once per open of the `@` mode. */
function useFocusedSymbols(enabled: boolean): FlatSymbol[] | null {
  const [symbols, setSymbols] = useState<FlatSymbol[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const st = useCodeStore.getState();
    const g = st.root ? groupsOfRoot(st, rootKey(st.root)) : null;
    const entry = g ? groupEditor(g.groups[g.focused]?.id ?? -1) : undefined;
    const model = entry?.editor.getModel();
    if (!entry || !model) return setSymbols([]);
    let live = true;
    void documentSymbols(entry.module, model).then((s) => {
      if (live) setSymbols(flattenSymbols(s ?? []));
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return symbols;
}

export default function QuickOpen({ label }: { label: string }): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const paths = useCodeStore((s) => s.filesByRootKey[rk]?.data?.paths ?? NONE);
  const recent = useCodeStore((s) => s.recentByRootKey[rk] ?? NONE);
  const hasActive = useCodeStore((s) => !!s.tabsByRootKey[rk]?.active);
  const close = () => useCodeStore.getState().setGoToFileOpen(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const parsed = useMemo(() => parseQuickQuery(query), [query]);
  const symbols = useFocusedSymbols(parsed.kind === 'symbol');

  const sections = useMemo(
    () => (parsed.kind === 'files' ? quickOpenSections(paths, parsed.text, recent) : { recent: [], files: [] }),
    [paths, recent, parsed],
  );
  const ranked = useMemo(() => (parsed.kind === 'symbol' && symbols ? rankSymbols(symbols, parsed.text) : []), [symbols, parsed]);

  const items: Item[] =
    parsed.kind === 'files'
      ? [...sections.recent, ...sections.files].map((row) => ({ kind: 'file' as const, row }))
      : parsed.kind === 'line'
        ? parsed.line !== null && hasActive
          ? [{ kind: 'line' as const, line: parsed.line, column: parsed.column }]
          : []
        : ranked.map((r) => ({ kind: 'symbol' as const, ranked: r }));

  const choose = (item: Item | undefined, side: boolean) => {
    if (!item) return;
    close();
    const st = useCodeStore.getState();
    if (item.kind === 'file') void st.openFile(item.row.path, { side });
    else if (item.kind === 'line') {
      const col = item.column ?? 1;
      st.selectInActive({ startLineNumber: item.line, startColumn: col, endLineNumber: item.line, endColumn: col });
    } else st.selectInActive(item.ranked.symbol.selectionRange);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, items.length - 1));
    else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
    else if (e.key === 'Enter') choose(items[cursor], e.metaKey || e.ctrlKey);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const renderRow = (item: Item, i: number) => {
    const on = i === cursor;
    const common = {
      role: 'option' as const,
      'aria-selected': on,
      className: on ? 'code-quick__row code-quick__row--on' : 'code-quick__row',
      onMouseEnter: () => setCursor(i),
      onMouseDown: (e: MouseEvent) => e.preventDefault(),
      onClick: (e: MouseEvent) => choose(item, e.metaKey || e.ctrlKey),
    };
    if (item.kind === 'file')
      return (
        <li key={`f:${item.row.path}`} {...common} title={item.row.path}>
          <Icon name="file" size={14} className="code-quick__icon" />
          <span className="code-quick__name">
            <Hits text={item.row.name} hits={item.row.hits} />
          </span>
          {item.row.dir && <span className="code-quick__dir">{item.row.dir}</span>}
        </li>
      );
    if (item.kind === 'line')
      return (
        <li key="line" {...common}>
          <Icon name="arrow-right" size={14} className="code-quick__icon" />
          <span className="code-quick__name">
            Go to line {item.line}
            {item.column ? `, column ${item.column}` : ''}
          </span>
        </li>
      );
    const s = item.ranked.symbol;
    return (
      <li key={`s:${i}`} {...common}>
        <Icon name="code" size={14} className="code-quick__icon" />
        <span className="code-quick__name">
          <Hits text={s.name} hits={item.ranked.hits} />
        </span>
        {s.container && <span className="code-quick__dir">{s.container}</span>}
        <span className="code-quick__line">:{s.selectionRange.startLineNumber}</span>
      </li>
    );
  };

  const empty =
    parsed.kind === 'line'
      ? hasActive
        ? 'Type a line number — :42 or :42:7'
        : 'Open a file to go to a line.'
      : parsed.kind === 'symbol'
        ? symbols === null
          ? 'Reading symbols…'
          : 'No symbols match.'
        : 'No matching files';

  const recentCount = parsed.kind === 'files' ? sections.recent.length : 0;

  return (
    <div className="code-quick" onMouseDown={close}>
      <div className="code-quick__panel" role="dialog" aria-label="Quick open" onMouseDown={(e) => e.stopPropagation()}>
        <div className="code-quick__field">
          <Icon name="search" size={14} className="code-quick__glyph" />
          <input
            className="code-quick__input"
            autoFocus
            placeholder="Search files by name — : line, @ symbol"
            aria-label="Quick open"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKey}
            onBlur={close}
          />
          {label && <span className="code-quick__scope">in {label}</span>}
        </div>
        <ul className="code-quick__list" role="listbox">
          {items.length === 0 && <li className="code-quick__empty">{empty}</li>}
          {recentCount > 0 && <li className="code-quick__section">Recently opened</li>}
          {items.slice(0, recentCount).map((it, i) => renderRow(it, i))}
          {parsed.kind === 'files' && items.length > recentCount && <li className="code-quick__section">Files</li>}
          {items.slice(recentCount).map((it, i) => renderRow(it, i + recentCount))}
        </ul>
        <footer className="code-quick__hints">
          <span>
            <Kbd keys="⏎" /> open
          </span>
          <span>
            <Kbd keys="⌘⏎" /> open to the side
          </span>
          <span>
            <Kbd keys=":42" /> go to line
          </span>
          <span>
            <Kbd keys="@" /> symbol
          </span>
        </footer>
      </div>
    </div>
  );
}

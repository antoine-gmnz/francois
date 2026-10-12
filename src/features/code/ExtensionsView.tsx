// code-editor-vsx FR-6 — the EXTENSIONS sidebar (the Search / Source control family of
// Figma 52/57): a search over Open VSX (300 ms debounce), INSTALLED + POPULAR while the
// query is empty, RESULTS otherwise, inline details per row, Load more, inline errors with
// Retry. Only the declarative half of an extension is ever used (FR-3).

import { useEffect, useMemo } from 'react';
import { Button } from '../../ui/Button';
import { InstalledRow, ResultRow } from './ExtensionRows';
import { useVsxStore } from './vsxStore';
import './code.css';
import './code-workspace.css';
import './code-vsx.css';

export default function ExtensionsView(): JSX.Element {
  const s = useVsxStore();
  const installedIds = useMemo(() => new Set(s.installed.map((i) => i.id)), [s.installed]);
  const searching = s.query.trim() !== '';

  useEffect(() => {
    if (useVsxStore.getState().searchStatus === 'idle') void useVsxStore.getState().search();
  }, []);

  const loading = s.searchStatus === 'loading';
  const canLoadMore = s.searchStatus !== 'error' && s.results.length > 0 && s.results.length < s.total;

  return (
    <aside className="code-search code-vsx" aria-label="Extensions">
      <div className="code-explorer__header">
        <span className="code-explorer__title">Extensions</span>
      </div>
      <div className="code-search__form">
        <div className="code-search__field">
          <input
            className="code-search__input"
            placeholder="Search Open VSX"
            aria-label="Search extensions on Open VSX"
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.search();
            }}
          />
        </div>
      </div>

      <div className="code-search__results">
        {!searching && s.installed.length > 0 && (
          <section aria-label="Installed">
            <h3 className="code-vsx__section">Installed</h3>
            {s.installed.map((ext) => (
              <InstalledRow key={ext.id} ext={ext} />
            ))}
          </section>
        )}

        <section aria-label={searching ? 'Results' : 'Popular'}>
          <h3 className="code-vsx__section">
            {searching ? 'Results' : 'Popular'}
            {loading && <span className="code-vsx__muted"> · loading…</span>}
          </h3>
          {s.results.map((ext) => (
            <ResultRow key={ext.id} ext={ext} installed={installedIds.has(ext.id)} />
          ))}
          {s.searchStatus === 'done' && s.results.length === 0 && <p className="code-search__summary">No extensions found.</p>}
          {s.searchStatus === 'error' && (
            <div className="code-vsx__error" role="alert">
              <p className="code-search__error">{s.searchError}</p>
              <Button variant="secondary" size="sm" onClick={() => void s.retry()}>
                Retry
              </Button>
            </div>
          )}
          {(canLoadMore || s.searchStatus === 'more') && (
            <div className="code-vsx__more-row">
              <Button variant="ghost" size="sm" busy={s.searchStatus === 'more'} onClick={() => void s.loadMore()}>
                Load more
              </Button>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

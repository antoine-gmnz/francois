// code-editor FR-6/FR-10/FR-12/FR-15 — the editor column (Figma 45 right side, 46
// when no file is open): the tab strip with Open in VS Code, the breadcrumb, the
// "Changed on disk" / "Deleted on disk" bars, Monaco, and the status bar.

import { useMemo, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Button } from '../../ui/Button';
import { bufferKey, bufferText } from './buffers';
import CodeEditor, { type CursorPos } from './CodeEditor';
import { tabLabels, type CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { detectIndent, indentLabel } from './editor-sync';
import { rootKey } from './editor-root';
import { languageFor } from './language';
import { openExternally, useDetectedEditor } from './open-external';
import './code.css';

const NO_TABS: CodeTab[] = [];

function EmptyEditor({ label }: { label: string }): JSX.Element {
  const rows: Array<[string, string]> = [
    ['⌘P', 'Go to file'],
    ['⌘S', 'Save'],
    ['⌘W', 'Close tab'],
    ['⌘F', 'Find in file'],
  ];
  return (
    <div className="code-empty">
      <Icon name="code" size={48} className="code-empty__icon" />
      <div className="code-empty__root">{label}</div>
      <p className="code-empty__line">Open a file from the explorer to edit it here.</p>
      <ul className="code-empty__keys">
        {rows.map(([k, what]) => (
          <li key={k} className="code-empty__key">
            <span>{what}</span>
            <Kbd keys={k} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EditorArea({ onRequestClose }: { onRequestClose: (path: string) => void }): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const tabs = useCodeStore((s) => s.tabsByRootKey[rk]?.tabs ?? NO_TABS);
  const activePath = useCodeStore((s) => s.tabsByRootKey[rk]?.active);
  const notice = useCodeStore((s) => s.noticeByRootKey[rk] ?? null);
  const files = useCodeStore((s) => s.filesByRootKey[rk]?.data ?? null);
  const { activate, closeTab, keepMine, reload, setNotice } = useCodeStore.getState();
  const editor = useDetectedEditor();
  const [cursor, setCursor] = useState<CursorPos>({ line: 1, col: 1 });

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  // FR-10: the indent the file already uses — read once per loaded version.
  const indent = useMemo(
    () => (active ? indentLabel(detectIndent(bufferText(bufferKey(rk, active.path)) ?? '')) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read per path/version, not per keystroke
    [rk, active?.path, active?.version],
  );

  const requestClose = (t: CodeTab) => {
    if (t.dirty) onRequestClose(t.path);
    else void closeTab(rk, t.path);
  };

  if (!root) return <div className="code-editor-area" />;

  return (
    <section className="code-editor-area">
      <div className="code-tabs" role="tablist">
        <div className="code-tabs__strip">
          {tabs.map((t) => {
            const on = t.path === activePath;
            const cls = ['code-tab'];
            if (on) cls.push('code-tab--active');
            if (t.dirty) cls.push('code-tab--dirty');
            if (t.deleted) cls.push('code-tab--deleted');
            return (
              <div key={t.path} role="tab" aria-selected={on} className={cls.join(' ')} title={t.path} onClick={() => activate(t.path)}>
                <Icon name="file" size={13} className="code-tab__icon" />
                <span className="code-tab__name">{labels[t.path]}</span>
                {t.dirty && <span className="code-tab__dot" aria-label="unsaved" />}
                <button
                  type="button"
                  className="code-tab__close"
                  title="Close · ⌘W"
                  aria-label={`Close ${labels[t.path]}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(t);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {editor && active && (
          <Button variant="ghost" size="sm" className="code-tabs__external" onClick={() => void openExternally(root, editor, active.path, cursor.line)}>
            <Icon name="external" size={13} />
            Open in {editor.label}
          </Button>
        )}
      </div>

      {notice && (
        <div className="code-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="code-notice__dismiss" aria-label="Dismiss" onClick={() => setNotice(rk, null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {active ? (
        <>
          <div className="code-crumbs">
            {active.path.split('/').map((seg, i, all) => (
              <span key={i} className={i === all.length - 1 ? 'code-crumbs__seg code-crumbs__seg--last' : 'code-crumbs__seg'}>
                {i > 0 && <span className="code-crumbs__sep">›</span>}
                {seg}
              </span>
            ))}
            {active.readOnly && <span className="code-crumbs__ro">{active.readOnlyReason === 'too-large' ? 'read-only · over 2 MiB' : 'read-only'}</span>}
          </div>

          {active.conflict && (
            <div className="code-bar" role="alert">
              <Icon name="warn" size={14} className="code-bar__icon" />
              <span className="code-bar__text">Changed on disk</span>
              <Button variant="secondary" size="sm" onClick={() => void reload(rk, active.path)}>
                Reload
              </Button>
              <Button variant="primary" size="sm" onClick={() => keepMine(rk, active.path)}>
                Keep mine
              </Button>
            </div>
          )}
          {active.deleted && !active.conflict && (
            <div className="code-bar" role="status">
              <Icon name="warn" size={14} className="code-bar__icon" />
              <span className="code-bar__text">Deleted on disk — ⌘S recreates it</span>
            </div>
          )}

          <CodeEditor rootKey={rk} tab={active} onCursor={setCursor} />
        </>
      ) : (
        <EmptyEditor label={files?.rootLabel ?? ''} />
      )}

      <footer className="code-status">
        <div className="code-status__left">
          {files?.branch && (
            <span className="code-status__item">
              <Icon name="branch" size={12} />
              {files.branch}
            </span>
          )}
          {active && !active.readOnly && <span className="code-status__item">{active.dirty ? 'Unsaved · ⌘S' : 'Saved'}</span>}
        </div>
        {active && (
          <div className="code-status__right">
            <span className="code-status__item">
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span className="code-status__item">{indent}</span>
            <span className="code-status__item">UTF-8</span>
            <span className="code-status__item">{active.lineEnding === 'crlf' ? 'CRLF' : 'LF'}</span>
            <span className="code-status__item">{languageFor(active.path).name}</span>
          </div>
        )}
      </footer>
    </section>
  );
}

// code-editor-workspace FR-2 — one editor group (Figma 52): its own tab strip (Review,
// split, Open in VS Code), breadcrumb with the caret's symbol (FR-5), the lock strip
// and disk bars, and its own Monaco instance — or the review diff. Two groups showing
// one file share its model (monaco-models.ts), so one buffer, one dirty state.
// Extracted from EditorArea (code-editor FR-6/FR-10/FR-12, code-editor-agents FR-9/
// FR-10/FR-16), which now lays out 1–2 of these.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import { Columns2 } from 'lucide-react';
import type { EditorRoot } from '../../../contract/code-editor';
import type { EditorInfo } from '../../../contract/open-in-vscode';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Button } from '../../ui/Button';
import { joinRoot } from '../../lib/path';
import CodeEditor, { type CursorPos } from './CodeEditor';
import ReviewEditor from './ReviewEditor';
import { LockStrip, SessionChip } from './AgentBits';
import { LspTrustBar, useLspOnShow } from './LspBits';
import { lockHoldersIn, type TouchView } from './touch-view';
import { tabLabels, type CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import type { EditorGroup as Group } from './editor-groups';
import { setGroupEditor } from './group-editors';
import type { MonacoModule } from './monaco-loader';
import { documentSymbols, onSymbolProvidersChange } from './monaco-symbols';
import { openExternally } from './open-external';
import { innermostSymbol } from './symbols';
import { useWorkspaceStore } from './workspaceStore';
import './code.css';
import './code-workspace.css';

const SYMBOL_DEBOUNCE_MS = 300;

/** FR-5: the innermost symbol at the caret, recomputed ≤ 300 ms after a caret move or edit. */
function useCaretSymbol(ed: Monaco.editor.IStandaloneCodeEditor | null, m: MonacoModule | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!ed || !m) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compute = async () => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos) return setName(null);
      const symbols = await documentSymbols(m, model);
      if (!live) return;
      const lang = model.getLanguageId();
      if (symbols && (lang === 'typescript' || lang === 'javascript')) useWorkspaceStore.getState().markTsReady();
      setName(symbols ? (innermostSymbol(symbols, { line: pos.lineNumber, column: pos.column })?.name ?? null) : null);
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void compute(), SYMBOL_DEBOUNCE_MS);
    };
    const subs = [ed.onDidChangeCursorPosition(later), ed.onDidChangeModelContent(later), ed.onDidChangeModel(later)];
    let providers: Monaco.IDisposable | null = null;
    void onSymbolProvidersChange(later).then((d) => {
      if (live) providers = d;
      else d?.dispose();
    });
    void compute();
    return () => {
      live = false;
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      providers?.dispose();
    };
  }, [ed, m]);
  return name;
}

/** FR-3/FR-11/FR-12: apply a pending selection aimed at this group once it shows the file. */
function useSelectRequest(ed: Monaco.editor.IStandaloneCodeEditor | null, groupId: number, rk: string, shownPath: string | null): void {
  const req = useCodeStore((s) => s.selectRequest);
  useEffect(() => {
    if (!ed || !req || req.groupId !== groupId || req.rootKey !== rk || req.path !== shownPath) return;
    const model = ed.getModel();
    if (!model) return;
    const r = model.validateRange(req.range);
    ed.setSelection(r);
    ed.revealRangeInCenterIfOutsideViewport(r);
    ed.focus();
    useCodeStore.getState().consumeSelect();
  }, [ed, req, groupId, rk, shownPath]);
}

export interface EditorGroupProps {
  root: EditorRoot;
  rk: string;
  index: number;
  group: Group;
  tabs: readonly CodeTab[];
  focused: boolean;
  split: boolean;
  rootDir: string | null;
  changes: Record<string, unknown>;
  view: TouchView;
  editor: EditorInfo | null;
  cursor: CursorPos;
  onCursor: (groupId: number, pos: CursorPos) => void;
  onRequestClose: (path: string) => void;
  /** Shown under the tab strip while the group has no file (the lone group of an empty root). */
  children?: ReactNode;
}

export default function EditorGroup({
  root,
  rk,
  index,
  group,
  tabs,
  focused,
  split,
  rootDir,
  changes,
  view,
  editor,
  cursor,
  onCursor,
  onRequestClose,
  children,
}: EditorGroupProps): JSX.Element {
  const { activate, closeInGroup, focusGroup, keepMine, reload, setReview, splitEditor } = useCodeStore.getState();
  const [instance, setInstance] = useState<{ ed: Monaco.editor.IStandaloneCodeEditor; m: MonacoModule } | null>(null);
  const absOf = (path: string) => (rootDir ? joinRoot(rootDir, path) : null);

  const byPath = useMemo(() => new Map(tabs.map((t) => [t.path, t])), [tabs]);
  const strip = useMemo(() => group.paths.map((p) => byPath.get(p)).filter((t): t is CodeTab => !!t), [group.paths, byPath]);
  const labels = useMemo(() => tabLabels(strip), [strip]);
  const active = (group.active && byPath.get(group.active)) || null;
  const activeAbs = active ? absOf(active.path) : null;
  const holders = lockHoldersIn(view, activeAbs);
  const lockedBy = holders.length > 0 ? (view.session(holders[0])?.name ?? 'a session') : null;
  // code-editor-agents FR-10: hidden for untracked files and for read-only too-large ones.
  const canReview = !!active && active.headText !== null && !(active.readOnly && active.readOnlyReason === 'too-large');
  const reviewing = canReview && !!active?.review;

  const onEditor = useCallback(
    (ed: Monaco.editor.IStandaloneCodeEditor | null, m: MonacoModule | null) => {
      setGroupEditor(group.id, ed && m ? { editor: ed, module: m } : null);
      setInstance(ed && m ? { ed, m } : null);
    },
    [group.id],
  );
  const symbol = useCaretSymbol(instance?.ed ?? null, instance?.m ?? null);
  // code-editor-lsp FR-15/FR-16: showing a file starts its server, or asks to trust the root.
  const lsp = useLspOnShow(root, rk, active?.path ?? null);
  useSelectRequest(instance?.ed ?? null, group.id, rk, reviewing ? null : (active?.path ?? null));

  const requestClose = (t: CodeTab) => {
    // §7: a dirty tab still open in the other group closes here without a prompt.
    if (t.dirty && !useCodeStore.getState().groupsByRootKey[rk]?.groups.some((g, i) => i !== index && g.paths.includes(t.path))) onRequestClose(t.path);
    else void closeInGroup(rk, index, t.path);
  };

  const cls = ['code-group'];
  if (split && !focused) cls.push('code-group--blurred');

  return (
    <section
      className={cls.join(' ')}
      aria-label={split ? `Editor group ${index + 1}` : undefined}
      onFocusCapture={() => {
        if (!focused) focusGroup(index);
      }}
      onMouseDown={() => {
        if (!focused) focusGroup(index);
      }}
    >
      <div className="code-tabs" role="tablist">
        <div className="code-tabs__strip">
          {strip.map((t) => {
            const on = t.path === group.active;
            const tc = ['code-tab'];
            if (on) tc.push('code-tab--active');
            if (t.dirty) tc.push('code-tab--dirty');
            if (t.deleted) tc.push('code-tab--deleted');
            return (
              <div key={t.path} role="tab" aria-selected={on} className={tc.join(' ')} title={t.path} onClick={() => activate(t.path, index)}>
                <Icon name="file" size={13} className="code-tab__icon" />
                <span className="code-tab__name">{labels[t.path]}</span>
                <SessionChip view={view} abs={absOf(t.path)} changed={!!changes[t.path]} />
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
        {canReview && active && (
          <Button
            variant="ghost"
            size="sm"
            className={reviewing ? 'code-tabs__review code-tabs__review--on' : 'code-tabs__review'}
            aria-pressed={reviewing}
            title="Inline diff against HEAD"
            onClick={() => setReview(rk, active.path, !active.review)}
          >
            Review
          </Button>
        )}
        {active && (
          <IconButton
            title={'Split editor · ⌘\\'}
            size={24}
            className="code-tabs__split"
            onClick={() => {
              focusGroup(index);
              splitEditor();
            }}
          >
            <Columns2 size={14} aria-hidden />
          </IconButton>
        )}
        {editor &&
          active &&
          (split ? (
            <IconButton title={`Open in ${editor.label}`} size={24} className="code-tabs__split" onClick={() => void openExternally(root, editor, active.path, cursor.line)}>
              <Icon name="external" size={13} />
            </IconButton>
          ) : (
            <Button variant="secondary" size="sm" className="code-tabs__external" onClick={() => void openExternally(root, editor, active.path, cursor.line)}>
              <Icon name="external" size={13} />
              Open in {editor.label}
            </Button>
          ))}
      </div>

      {!active && children}
      {active && (
        <>
          <div className="code-crumbs">
            {active.path.split('/').map((seg, i, all) => (
              <span key={i} className={i === all.length - 1 && !symbol ? 'code-crumbs__seg code-crumbs__seg--last' : 'code-crumbs__seg'}>
                {i > 0 && <span className="code-crumbs__sep">›</span>}
                {seg}
              </span>
            ))}
            {symbol && !reviewing && (
              <span className="code-crumbs__seg code-crumbs__seg--last code-crumbs__symbol">
                <span className="code-crumbs__sep">›</span>
                {symbol}
              </span>
            )}
            {active.readOnly && <span className="code-crumbs__ro">{active.readOnlyReason === 'too-large' ? 'read-only · over 2 MiB' : 'read-only'}</span>}
          </div>

          {/* code-editor-agents FR-16: announced politely; stacks above the v1 "Changed on disk" bar. */}
          <div className="code-lock-region" aria-live="polite">
            {activeAbs && <LockStrip view={view} abs={activeAbs} holders={holders} />}
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
          {lsp.prompt && (focused || !split) && <LspTrustBar root={root} rk={rk} />}
          {active.deleted && !active.conflict && (
            <div className="code-bar" role="status">
              <Icon name="warn" size={14} className="code-bar__icon" />
              <span className="code-bar__text">Deleted on disk — ⌘S recreates it</span>
            </div>
          )}

          {reviewing ? (
            <ReviewEditor rootKey={rk} tab={active} abs={activeAbs} lockedBy={lockedBy} />
          ) : (
            <CodeEditor
              rootKey={rk}
              tab={active}
              groupId={group.id}
              onEditor={onEditor}
              onCursor={(pos) => onCursor(group.id, pos)}
              abs={activeAbs}
              rootDir={rootDir}
              locked={lockedBy !== null}
            />
          )}
        </>
      )}
    </section>
  );
}

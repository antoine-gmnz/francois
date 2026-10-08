// code-editor FR-7/FR-9 — the Monaco host. Monaco is loaded lazily from the local
// bundle (monaco-loader.ts); one editor instance swaps between the tabs' models, each
// tab keeping its own undo stack and view state (FR-2/FR-6). Change markers against
// HEAD are line decorations, recomputed 200 ms after an edit (FR-9). §7: a failed
// load shows "Editor failed to load" + Retry, and the tree keeps working.

import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { useStore } from '../../lib/store';
import { bufferKey } from './buffers';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { gutterMarks } from './gutter-diff';
import { loadMonaco, type MonacoModule } from './monaco-loader';
import { ensureModel } from './monaco-models';
import './code.css';

export interface CursorPos {
  line: number;
  col: number;
}

const GUTTER_DEBOUNCE_MS = 200;

function markerDecorations(monaco: MonacoModule['monaco'], head: string, text: string): Monaco.editor.IModelDeltaDecoration[] {
  const marks = gutterMarks(head, text);
  const deco = (line: number, cls: string): Monaco.editor.IModelDeltaDecoration => ({
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, linesDecorationsClassName: `code-gutter code-gutter--${cls}` },
  });
  return [
    ...marks.modified.map((l) => deco(l, 'modified')),
    ...marks.added.map((l) => deco(l, 'added')),
    ...marks.deleted.map((l) => deco(l, 'deleted')),
  ];
}

export default function CodeEditor({ rootKey, tab, onCursor }: { rootKey: string; tab: CodeTab; onCursor: (pos: CursorPos) => void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const moduleRef = useRef<MonacoModule | null>(null);
  const shownRef = useRef<{ rootKey: string; path: string } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const theme = useStore((s) => s.theme);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  // FR-2: park the shown tab's cursor + scroll before it is swapped out or unmounted.
  const stash = () => {
    const ed = editorRef.current;
    const shown = shownRef.current;
    if (ed && shown) useCodeStore.getState().saveViewState(shown.rootKey, shown.path, ed.saveViewState());
  };

  useEffect(() => {
    let live = true;
    setState('loading');
    loadMonaco()
      .then((m) => {
        if (!live || !hostRef.current) return;
        moduleRef.current = m;
        m.applyGraphiteTheme();
        const ed = m.monaco.editor.create(hostRef.current, {
          model: null,
          theme: m.GRAPHITE_THEME,
          automaticLayout: true,
          minimap: { enabled: true },
          fontFamily: "'Geist Mono', ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 20,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          lineDecorationsWidth: 10,
          fixedOverflowWidgets: true,
        });
        ed.onDidChangeCursorPosition((e) => onCursorRef.current({ line: e.position.lineNumber, col: e.position.column }));
        editorRef.current = ed;
        // The self-hosted Geist Mono may land after Monaco measured the fallback.
        void document.fonts?.ready.then(() => m.monaco.editor.remeasureFonts());
        setState('ready');
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
      stash();
      shownRef.current = null;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [attempt]);

  // FR-7: re-generate the theme from the tokens whenever data-theme flips.
  useEffect(() => {
    if (state === 'ready') moduleRef.current?.applyGraphiteTheme();
  }, [theme, state]);

  // Swap in the active tab's model and restore its view state.
  useEffect(() => {
    const ed = editorRef.current;
    const m = moduleRef.current;
    if (state !== 'ready' || !ed || !m) return;
    const path = tab.path;
    const model = ensureModel(m.monaco, bufferKey(rootKey, path), path, (dirty) => useCodeStore.getState().setDirty(rootKey, path, dirty));
    ed.setModel(model);
    shownRef.current = { rootKey, path };
    const saved = useCodeStore.getState().tabsByRootKey[rootKey]?.tabs.find((t) => t.path === path)?.viewState;
    if (saved) ed.restoreViewState(saved as Monaco.editor.ICodeEditorViewState);
    const pos = ed.getPosition();
    if (pos) onCursorRef.current({ line: pos.lineNumber, col: pos.column });
    ed.focus();
    return stash;
  }, [state, rootKey, tab.path]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: tab.readOnly });
  }, [state, tab.readOnly, tab.path]);

  // FR-9: change markers against HEAD (none for an untracked file).
  useEffect(() => {
    const ed = editorRef.current;
    const m = moduleRef.current;
    const model = ed?.getModel();
    if (state !== 'ready' || !ed || !m || !model) return;
    const collection = ed.createDecorationsCollection();
    const head = tab.headText;
    if (head === null) return () => collection.clear();
    const paint = () => collection.set(markerDecorations(m.monaco, head, model.getValue()));
    paint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(paint, GUTTER_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
      collection.clear();
    };
  }, [state, rootKey, tab.path, tab.headText]);

  return (
    <div className="code-monaco">
      <div className="code-monaco__host" ref={hostRef} />
      {state === 'loading' && <div className="code-monaco__overlay">Loading editor…</div>}
      {state === 'failed' && (
        <div className="code-monaco__overlay">
          <span>Editor failed to load</span>
          <button type="button" className="code-tree__retry" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

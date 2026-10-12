// code-editor FR-7/FR-9 — the Monaco host. Monaco is loaded lazily from the local
// bundle (monaco-loader.ts); one editor instance swaps between the tabs' models, each
// tab keeping its own undo stack and view state (FR-2/FR-6). Change markers against
// HEAD are line decorations, recomputed 200 ms after an edit (FR-9). §7: a failed
// load shows "Editor failed to load" + Retry, and the tree keeps working.
//
// code-editor-agents adds: ⌘L and the gutter `+` comment box (FR-4) handing content
// to a session (FR-5), the line flash after an agent's write (FR-8), revealing a line
// on a transcript jump (FR-15), and read-only while a session edits the file (FR-16).
//
// code-editor-workspace adds: the Graphite completion / hover / find widgets (FR-6,
// FR-8, FR-10 — options here, looks in monaco-widgets.css), inline blame (FR-7,
// useInlineBlame.ts) and "Send to <target> with this problem" (FR-9) — both the code
// action every marker contributes and ⌘L on a marker with nothing selected.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as Monaco from 'monaco-editor';
import { AGENT_FLASH_MS } from '../../../contract/code-editor-agents';
import { selectionChip } from '../../lib/context-chips';
import { useStore } from '../../lib/store';
import { AddedPill } from './AgentBits';
import { bufferKey } from './buffers';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { gutterMarks } from './gutter-diff';
import { languageFor } from './language';
import { loadMonaco, type MonacoModule } from './monaco-loader';
import { ensureModel } from './monaco-models';
import { markerAt, problemChip, problemTargets, problemTargetTitle, type ProblemMarker } from './problem-send';
import { CommentBox, TargetPicker } from './SendToSession';
import { useChipSender, useTargetLabel, type Anchor, type ChipSender } from './useChipSender';
import { useInlineBlame } from './useInlineBlame';
import './code.css';
import './monaco-widgets.css';

export interface CursorPos {
  line: number;
  col: number;
}

const GUTTER_DEBOUNCE_MS = 200;
const COMMENT_ZONE_PX = 88;

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

/** Where a popover anchored under `line` goes, in the editor's own pixels. */
function anchorUnder(ed: Monaco.editor.ICodeEditor, line: number, extra = 0): Anchor {
  const pos = ed.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
  const layout = ed.getLayoutInfo();
  const top = (pos ? pos.top + pos.height : 0) + extra + 4;
  return { top: Math.max(0, Math.min(top, layout.height - 220)), left: layout.contentLeft + 8 };
}

interface SendCtx {
  abs: string | null;
  path: string;
  rootDir: string | null;
  send: ChipSender['send'];
}

/** FR-9: the marker's line(s) as a selection chip whose note is the problem. */
function sendProblem(ed: Monaco.editor.ICodeEditor, marker: ProblemMarker, ctx: SendCtx): void {
  const model = ed.getModel();
  if (!model || !ctx.abs) return;
  const last = model.getLineCount();
  const m = { ...marker, startLineNumber: Math.min(marker.startLineNumber, last), endLineNumber: Math.min(marker.endLineNumber, last) };
  const chip = problemChip(m, (l) => model.getLineContent(l), { path: ctx.abs, language: languageFor(ctx.path).id, now: Date.now() });
  ctx.send(chip, anchorUnder(ed, m.endLineNumber));
}

export default function CodeEditor({
  rootKey,
  tab,
  onCursor,
  abs,
  rootDir,
  locked,
  groupId = 0,
  onEditor,
}: {
  rootKey: string;
  tab: CodeTab;
  onCursor: (pos: CursorPos) => void;
  /** code-editor-workspace FR-2: the editor group (EditorGroup.id) — keys the view state. */
  groupId?: number;
  /** code-editor-workspace FR-2/FR-5/FR-11: the instance once created, null once disposed. */
  onEditor?: (ed: Monaco.editor.IStandaloneCodeEditor | null, m: MonacoModule | null) => void;
  /** code-editor-agents: the tab's absolute normalised path, null until `editor_files` landed. */
  abs: string | null;
  rootDir: string | null;
  /** FR-16: a session is editing this file. */
  locked: boolean;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const moduleRef = useRef<MonacoModule | null>(null);
  const shownRef = useRef<{ rootKey: string; path: string } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const theme = useStore((s) => s.theme);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  const groupRef = useRef(groupId);
  groupRef.current = groupId;
  const key = bufferKey(rootKey, tab.path);
  const flash = useCodeStore((s) => s.flashByKey[key]);
  const reveal = useCodeStore((s) => s.revealByKey[key]);

  // code-editor-agents FR-4/FR-5
  const sender = useChipSender(rootDir);
  const targetLabel = useTargetLabel(rootDir);
  const [comment, setComment] = useState<{ line: number } | null>(null);
  const [zoneNode, setZoneNode] = useState<HTMLElement | null>(null);
  const ctxRef = useRef<SendCtx>({ abs, path: tab.path, rootDir, send: sender.send });
  ctxRef.current = { abs, path: tab.path, rootDir, send: sender.send };

  // FR-2: park the shown tab's cursor + scroll before it is swapped out or unmounted.
  const stash = () => {
    const ed = editorRef.current;
    const shown = shownRef.current;
    if (ed && shown) useCodeStore.getState().saveViewState(shown.rootKey, shown.path, ed.saveViewState(), groupRef.current);
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
          // code-editor-agents: room for the 14px `+` beside the 3px change markers.
          lineDecorationsWidth: 26,
          fixedOverflowWidgets: true,
          // code-editor-workspace FR-6/FR-8 (looks: monaco-widgets.css)
          suggest: { showStatusBar: true, preview: true, showInlineDetails: true },
          suggestFontSize: 13,
          suggestLineHeight: 24,
          hover: { delay: 300, sticky: true },
          lightbulb: { enabled: m.monaco.editor.ShowLightbulbIconMode.OnCode },
        });
        ed.onDidChangeCursorPosition((e) => onCursorRef.current({ line: e.position.lineNumber, col: e.position.column }));

        // FR-4: ⌘L (Ctrl+L off macOS) over Monaco's own expand-line-selection.
        ed.addCommand(m.monaco.KeyMod.CtrlCmd | m.monaco.KeyCode.KeyL, () => {
          const model = ed.getModel();
          const sel = ed.getSelection();
          const { abs: path, send } = ctxRef.current;
          if (!model || !sel || !path) return;
          if (sel.isEmpty()) {
            // code-editor-workspace FR-9: on a marker, hand over the problem; else §7's no-op.
            const markers = m.monaco.editor.getModelMarkers({ resource: model.uri });
            const marker = markerAt(markers, sel.positionLineNumber, sel.positionColumn);
            if (marker) sendProblem(ed, marker, ctxRef.current);
            return;
          }
          let end = sel.endLineNumber;
          if (sel.endColumn === 1 && end > sel.startLineNumber) end--;
          const lines: string[] = [];
          for (let l = sel.startLineNumber; l <= end; l++) lines.push(model.getLineContent(l));
          const language = languageFor(ctxRef.current.path).id;
          send(selectionChip({ path, startLine: sel.startLineNumber, lines, language, now: Date.now() }), anchorUnder(ed, end));
        });

        // FR-4: the gutter `+` on the hovered line; a click opens the comment box under it.
        const GUTTER = m.monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;
        const hover = ed.createDecorationsCollection();
        let hovered = 0;
        ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber ?? 0;
          if (line === hovered) return;
          hovered = line;
          if (!line) return hover.clear();
          hover.set([{ range: new m.monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: 'code-gutter-add' } }]);
        });
        ed.onMouseLeave(() => {
          hovered = 0;
          hover.clear();
        });
        ed.onMouseDown((e) => {
          const line = e.target.position?.lineNumber;
          if (e.target.type === GUTTER && line && e.target.element?.classList.contains('code-gutter-add')) setComment({ line });
        });

        editorRef.current = ed;
        onEditorRef.current?.(ed, m);
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
      if (editorRef.current) onEditorRef.current?.(null, null);
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
    const saved = useCodeStore.getState().viewStateOf(rootKey, path, groupRef.current);
    if (saved) ed.restoreViewState(saved as Monaco.editor.ICodeEditorViewState);
    const pos = ed.getPosition();
    if (pos) onCursorRef.current({ line: pos.lineNumber, col: pos.column });
    ed.focus();
    setComment(null);
    return stash;
  }, [state, rootKey, tab.path]);

  // code-editor-workspace FR-9: this editor answers the problem code action for its model
  // (the last-focused editor wins when both split groups show the same file).
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (state !== 'ready' || !ed || !model) return;
    const uri = model.uri.toString();
    const target = {
      title: () => problemTargetTitle(useStore.getState().sessions, ctxRef.current.rootDir ?? ''),
      send: (marker: ProblemMarker) => sendProblem(ed, marker, ctxRef.current),
    };
    const off = problemTargets.register(uri, target);
    const focus = ed.onDidFocusEditorText(() => problemTargets.focus(uri, target));
    return () => {
      focus.dispose();
      off();
    };
  }, [state, rootKey, tab.path]);

  // code-editor-workspace FR-7
  useInlineBlame(state === 'ready' ? editorRef.current : null, state === 'ready' ? moduleRef.current : null, rootKey, tab);

  // code-editor-agents FR-15: a transcript jump lands on its line.
  useEffect(() => {
    const ed = editorRef.current;
    if (state !== 'ready' || !ed || reveal === undefined) return;
    ed.setPosition({ lineNumber: reveal, column: 1 });
    ed.revealLineInCenter(reveal);
    useCodeStore.getState().consumeReveal(key);
  }, [state, key, reveal]);

  // FR-16/FR-19: read-only while a session is editing this file (and for v1's reasons).
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: tab.readOnly || locked });
  }, [state, tab.readOnly, tab.path, locked]);

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

  // code-editor-agents FR-8: the lines an agent's write changed flash cyan, then fade
  // (code.css; reduced motion holds and cuts). A stale entry (tab re-shown) never replays.
  useEffect(() => {
    const ed = editorRef.current;
    const m = moduleRef.current;
    if (state !== 'ready' || !ed || !m || !flash) return;
    const left = AGENT_FLASH_MS - (Date.now() - flash.at);
    if (left <= 0) return;
    const collection = ed.createDecorationsCollection(
      flash.lines.map((l) => ({ range: new m.monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'code-flash' } })),
    );
    const timer = setTimeout(() => collection.clear(), left);
    return () => {
      clearTimeout(timer);
      collection.clear();
    };
  }, [state, flash]);

  // FR-4: the comment box is a view zone under its line.
  useEffect(() => {
    const ed = editorRef.current;
    if (state !== 'ready' || !ed || !comment) return;
    const node = document.createElement('div');
    node.className = 'code-comment-zone';
    // Keep Monaco from taking the click (and the caret) away from the textarea.
    node.addEventListener('mousedown', (e) => e.stopPropagation());
    let id = '';
    ed.changeViewZones((acc) => {
      id = acc.addZone({ afterLineNumber: comment.line, heightInPx: COMMENT_ZONE_PX, domNode: node });
    });
    setZoneNode(node);
    return () => {
      ed.changeViewZones((acc) => acc.removeZone(id));
      setZoneNode(null);
    };
  }, [state, comment]);

  const submitComment = (note: string) => {
    const ed = editorRef.current;
    if (!ed || !comment || !abs) return;
    const at = anchorUnder(ed, comment.line, COMMENT_ZONE_PX);
    const { line } = comment;
    setComment(null);
    ed.focus();
    sender.send({ id: crypto.randomUUID(), kind: 'comment', path: abs, startLine: line, endLine: line, note, createdAt: Date.now() }, at);
  };

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
      {zoneNode &&
        comment &&
        createPortal(
          <CommentBox
            target={targetLabel}
            onSubmit={submitComment}
            onCancel={() => {
              setComment(null);
              editorRef.current?.focus();
            }}
          />,
          zoneNode,
        )}
      {sender.picker && (
        <TargetPicker
          state={sender.picker}
          onPick={(id) => {
            sender.pick(id);
            editorRef.current?.focus();
          }}
          onCancel={() => {
            sender.cancelPicker();
            editorRef.current?.focus();
          }}
        />
      )}
      <AddedPill notice={sender.notice} onDone={sender.clearNotice} />
    </div>
  );
}

// code-editor-agents FR-10..FR-13 / FR-19 — Review: the active tab as Monaco's
// inline diff editor, original = the HEAD blob, modified = the live buffer (the same
// model the plain editor uses, so edits and undo carry across the toggle). Hovering a
// hunk shows **Revert**, which puts the HEAD lines back, saves at once when the buffer
// was clean, and hands the last toucher a "reverted" chip. Disabled while locked.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { addChip, CHIP_LIMIT_MESSAGE } from '../../lib/context-chips';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { chipFor } from './agent-touch';
import { AddedPill, type AddedNotice } from './AgentBits';
import { bufferKey, bufferText, replaceBufferText } from './buffers';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { languageFor } from './language';
import { loadMonaco, type MonacoModule } from './monaco-loader';
import { ensureModel } from './monaco-models';
import { hunkAt, revertHunk } from './review-revert';
import './code.css';
import './monaco-widgets.css';

const REVERT_NOTE = 'I reverted this change.';

interface Hovered {
  change: Monaco.editor.ILineChange;
  top: number;
}

export default function ReviewEditor({
  rootKey,
  tab,
  abs,
  lockedBy,
}: {
  rootKey: string;
  tab: CodeTab;
  abs: string | null;
  /** FR-13/FR-19: the session locking this file, or null. */
  lockedBy: string | null;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const moduleRef = useRef<MonacoModule | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [changes, setChanges] = useState<Monaco.editor.ILineChange[]>([]);
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [notice, setNotice] = useState<AddedNotice | null>(null);
  const theme = useStore((s) => s.theme);
  const clearNotice = useCallback(() => setNotice(null), []);
  const changesRef = useRef(changes);
  changesRef.current = changes;

  useEffect(() => {
    let live = true;
    loadMonaco()
      .then((m) => {
        if (!live || !hostRef.current) return;
        moduleRef.current = m;
        m.applyGraphiteTheme();
        const diff = m.monaco.editor.createDiffEditor(hostRef.current, {
          theme: m.GRAPHITE_THEME,
          automaticLayout: true,
          renderSideBySide: false,
          originalEditable: false,
          renderMarginRevertIcon: false,
          fontFamily: "'Geist Mono', ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          minimap: { enabled: false },
        });
        diff.onDidUpdateDiff(() => setChanges(diff.getLineChanges() ?? []));
        const mod = diff.getModifiedEditor();
        mod.onMouseMove((e) => {
          const line = e.target.position?.lineNumber;
          const change = line ? hunkAt(changesRef.current, line) : null;
          if (!change) return setHovered(null);
          const anchor = Math.max(change.modifiedStartLineNumber, 1);
          setHovered({ change, top: mod.getTopForLineNumber(anchor) - mod.getScrollTop() });
        });
        mod.onDidScrollChange(() => setHovered(null));
        diffRef.current = diff;
        setState('ready');
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
      const diff = diffRef.current;
      const original = diff?.getModel()?.original;
      diff?.dispose();
      original?.dispose();
      diffRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state === 'ready') moduleRef.current?.applyGraphiteTheme();
  }, [theme, state]);

  // original = HEAD, modified = the tab's own buffer model.
  useEffect(() => {
    const diff = diffRef.current;
    const m = moduleRef.current;
    if (state !== 'ready' || !diff || !m || tab.headText === null) return;
    const path = tab.path;
    const modified = ensureModel(m.monaco, bufferKey(rootKey, path), path, (dirty) => useCodeStore.getState().setDirty(rootKey, path, dirty));
    if (!modified) return;
    const original = m.monaco.editor.createModel(tab.headText, languageFor(path).id);
    const before = diff.getModel()?.original;
    diff.setModel({ original, modified });
    before?.dispose();
    setHovered(null);
  }, [state, rootKey, tab.path, tab.headText]);

  useEffect(() => {
    diffRef.current?.getModifiedEditor().updateOptions({ readOnly: tab.readOnly || lockedBy !== null });
  }, [state, tab.readOnly, lockedBy]);

  const revert = async (change: Monaco.editor.ILineChange) => {
    const head = tab.headText;
    const key = bufferKey(rootKey, tab.path);
    const text = bufferText(key);
    if (head === null || text === null || lockedBy !== null) return;
    const wasClean = !tab.dirty;
    const r = revertHunk(text, head, change);
    replaceBufferText(key, r.text, true);
    setHovered(null);
    if (wasClean) {
      // FR-11: saves through editor_save with the loaded baseVersion; EDITOR_STALE
      // leaves the reverted text dirty under the v1 "Changed on disk" bar.
      const res = await useCodeStore.getState().save(rootKey, tab.path);
      if (!res.ok) return;
    }
    // FR-12: tell the last toucher, file-level attribution (§7 states the limit).
    const toucher = abs ? chipFor(abs) : null;
    const session = toucher && useStore.getState().sessions.find((s) => s.id === toucher.sessionId);
    if (!abs || !session) return;
    const res = addChip(session.id, {
      id: crypto.randomUUID(),
      kind: 'revert',
      path: abs,
      startLine: r.startLine,
      endLine: r.endLine,
      note: REVERT_NOTE,
      createdAt: Date.now(),
    });
    setNotice(res.ok ? { text: `Added to ${session.name}`, sessionId: session.id } : { text: CHIP_LIMIT_MESSAGE });
  };

  return (
    <div className="code-monaco" onMouseLeave={() => setHovered(null)}>
      <div className="code-monaco__host" ref={hostRef} />
      {state === 'loading' && <div className="code-monaco__overlay">Loading editor…</div>}
      {state === 'failed' && <div className="code-monaco__overlay">Editor failed to load</div>}
      {hovered && (
        <div
          className="code-revert"
          // A disabled button shows no tooltip, so FR-13's reason rides the wrapper.
          title={lockedBy !== null ? `Locked while ${lockedBy} is editing` : undefined}
          // eslint-disable-next-line no-restricted-syntax -- pinned to the hovered hunk's top, computed at runtime
          style={{ top: Math.max(0, hovered.top) }}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={lockedBy !== null}
            title={lockedBy !== null ? undefined : 'Revert this hunk to HEAD'}
            onClick={() => void revert(hovered.change)}
          >
            <Undo2 size={13} aria-hidden />
            Revert
          </Button>
        </div>
      )}
      <AddedPill notice={notice} onDone={clearNotice} />
    </div>
  );
}

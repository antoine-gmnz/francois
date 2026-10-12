// code-editor-workspace FR-7 — the caret line's blame as an `after` injected-text
// decoration, fetched once the caret has settled on a line for 400 ms. Hidden while
// the buffer is dirty (the core blames the file on disk, so a dirty buffer's line
// numbers may no longer match), for untracked files (no HEAD text) and on a null answer.

import { useEffect } from 'react';
import type * as Monaco from 'monaco-editor';
import { BLAME_SETTLE_MS, BlameCache, fetchBlame, formatBlame, useBlameStore } from './blame';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import type { MonacoModule } from './monaco-loader';

const cache = new BlameCache();
const GAP = ' '.repeat(4);

export function useInlineBlame(ed: Monaco.editor.IStandaloneCodeEditor | null, m: MonacoModule | null, rootKey: string, tab: CodeTab): void {
  const enabled = useBlameStore((s) => s.enabled);
  const { path, version, headText, dirty } = tab;
  const tracked = headText !== null;

  useEffect(() => {
    const root = useCodeStore.getState().rootsByKey[rootKey];
    if (!ed || !m || !enabled || !tracked || dirty || !root) return;
    const collection = ed.createDecorationsCollection();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown = 0;

    const paint = (line: number, text: string) => {
      const model = ed.getModel();
      if (!model || line > model.getLineCount()) return;
      const col = model.getLineMaxColumn(line);
      collection.set([
        {
          range: new m.monaco.Range(line, col, line, col),
          options: { after: { content: `${GAP}${text}`, inlineClassName: 'code-blame' } },
        },
      ]);
      shown = line;
    };

    const schedule = () => {
      clearTimeout(timer);
      const line = ed.getPosition()?.lineNumber ?? 0;
      if (line !== shown) {
        collection.clear();
        shown = 0;
      }
      if (!line || line === shown) return;
      timer = setTimeout(() => {
        void fetchBlame(cache, root, path, version, line).then((blame) => {
          if (live && blame && ed.getPosition()?.lineNumber === line) paint(line, formatBlame(blame, Date.now()));
        });
      }, BLAME_SETTLE_MS);
    };

    const sub = ed.onDidChangeCursorPosition(schedule);
    schedule();
    return () => {
      live = false;
      clearTimeout(timer);
      sub.dispose();
      collection.clear();
    };
  }, [ed, m, enabled, tracked, dirty, rootKey, path, version]);
}

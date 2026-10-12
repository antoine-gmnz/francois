// code-editor FR-6/FR-10/FR-12/FR-15 — the editor column (Figma 45 right side, 46
// when no file is open). code-editor-workspace (Figma 52) splits it: one or two
// editor groups side by side (EditorGroup.tsx — tab strip, breadcrumb, bars, Monaco),
// the PROBLEMS panel under them (FR-3), the status bar with the problem counts and the
// TypeScript pill (FR-4), and quick open dropping from the top (FR-11). code-editor-lsp
// FR-14: the pill reads the active file's language server when one applies.

import { useMemo, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { joinRoot } from '../../lib/path';
import { bufferKey, bufferText } from './buffers';
import type { CursorPos } from './CodeEditor';
import EditorGroup from './EditorGroup';
import ProblemsPanel from './ProblemsPanel';
import QuickOpen from './QuickOpen';
import { lockHoldersIn, useTouchView } from './touch-view';
import type { CodeTab } from './code-tabs';
import { useCodeStore } from './codeStore';
import { singleGroup } from './editor-groups';
import { detectIndent, indentLabel } from './editor-sync';
import { rootKey } from './editor-root';
import { languageFor } from './language';
import { LspPill } from './LspBits';
import { useDetectedEditor } from './open-external';
import { problemCounts } from './problems';
import { useRootProblems } from './useRootProblems';
import { useWorkspaceStore } from './workspaceStore';
import { useVsxStore } from './vsxStore';
import './code.css';
import './code-workspace.css';

const NO_TABS: CodeTab[] = [];
const NO_CHANGES: Record<string, unknown> = {};
const START: CursorPos = { line: 1, col: 1 };

function EmptyEditor({ label }: { label: string }): JSX.Element {
  const rows: Array<[string, string]> = [
    ['⌘P', 'Go to file'],
    ['⌘⇧F', 'Search in files'],
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

/** FR-4: `● TypeScript <version> · ready` for TS/JS files; a dim dot and `loading` until the worker answered. */
function LanguagePill(): JSX.Element | null {
  const version = useWorkspaceStore((s) => s.tsVersion);
  const ready = useWorkspaceStore((s) => s.tsReady);
  if (!version) return null;
  return (
    <span className="code-status__item code-status__lang" title="Monaco's bundled TypeScript language service">
      <span className={ready ? 'code-status__dot code-status__dot--ready' : 'code-status__dot'} />
      TypeScript {version} · {ready ? 'ready' : 'loading'}
    </span>
  );
}

export default function EditorArea({ onRequestClose }: { onRequestClose: (path: string) => void }): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const rk = root ? rootKey(root) : '';
  const tabs = useCodeStore((s) => s.tabsByRootKey[rk]?.tabs ?? NO_TABS);
  const stored = useCodeStore((s) => s.groupsByRootKey[rk]);
  const activePath = useCodeStore((s) => s.tabsByRootKey[rk]?.active);
  const notice = useCodeStore((s) => s.noticeByRootKey[rk] ?? null);
  const files = useCodeStore((s) => s.filesByRootKey[rk]?.data ?? null);
  const quickOpen = useCodeStore((s) => s.goToFileOpen);
  const problems = useRootProblems(rk);
  const problemsOpen = useWorkspaceStore((s) => s.problemsOpen);
  const maximized = useWorkspaceStore((s) => s.problemsMaximized);
  const { setNotice } = useCodeStore.getState();
  const view = useTouchView();
  const editor = useDetectedEditor();
  const [cursors, setCursors] = useState<Record<number, CursorPos>>({});

  // FR-2: one group over the tab records until a split (or any group move) stored them.
  const groups = useMemo(
    () =>
      stored ??
      singleGroup(
        tabs.map((t) => t.path),
        activePath,
      ),
    [stored, tabs, activePath],
  );
  const split = groups.groups.length > 1;
  const focusedGroup = groups.groups[groups.focused];
  const active = tabs.find((t) => t.path === focusedGroup?.active) ?? null;
  const cursor = (focusedGroup && cursors[focusedGroup.id]) || START;
  const activeAbs = active && files?.rootDir ? joinRoot(files.rootDir, active.path) : null;
  const locked = lockHoldersIn(view, activeAbs).length > 0;
  const counts = problemCounts(problems);
  // code-editor-vsx FR-10: re-render when the contributed languages change, so the status
  // bar names the language a newly enabled extension gives the file.
  useVsxStore((s) => s.contributions);
  const lang = active ? languageFor(active.path) : null;
  // code-editor FR-10: the indent the file already uses — read once per loaded version.
  const indent = useMemo(
    () => (active ? indentLabel(detectIndent(bufferText(bufferKey(rk, active.path)) ?? '')) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read per path/version, not per keystroke
    [rk, active?.path, active?.version],
  );

  if (!root) return <div className="code-editor-area" />;

  const onCursor = (groupId: number, pos: CursorPos) => setCursors((c) => (c[groupId]?.line === pos.line && c[groupId]?.col === pos.col ? c : { ...c, [groupId]: pos }));

  return (
    <section className="code-editor-area code-editor-area--workspace">
      {notice && (
        <div className="code-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="code-notice__dismiss" aria-label="Dismiss" onClick={() => setNotice(rk, null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      <div className={maximized && problemsOpen ? 'code-groups code-groups--hidden' : 'code-groups'}>
        {groups.groups.map((g, i) => (
          <EditorGroup
            key={g.id}
            root={root}
            rk={rk}
            index={i}
            group={g}
            tabs={tabs}
            focused={i === groups.focused}
            split={split}
            rootDir={files?.rootDir ?? null}
            changes={files?.changes ?? NO_CHANGES}
            view={view}
            editor={editor}
            cursor={cursors[g.id] ?? START}
            onCursor={onCursor}
            onRequestClose={onRequestClose}
          >
            <EmptyEditor label={files?.rootLabel ?? ''} />
          </EditorGroup>
        ))}
      </div>

      {problemsOpen && <ProblemsPanel rootKey={rk} />}

      <footer className="code-status">
        <div className="code-status__left">
          {files?.branch && (
            <span className="code-status__item">
              <Icon name="branch" size={12} />
              {files.branch}
            </span>
          )}
          {active && !active.readOnly && <span className="code-status__item">{locked ? (active.dirty ? 'Unsaved · locked' : 'Locked') : active.dirty ? 'Unsaved · ⌘S' : 'Saved'}</span>}
          <button
            type="button"
            className="code-status__item code-status__problems"
            title={`${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} info · ⌘⇧M`}
            aria-pressed={problemsOpen}
            onClick={() => useWorkspaceStore.getState().toggleProblems()}
          >
            <Icon name="warn" size={12} />
            {counts.errors + counts.warnings}
            <Icon name="info" size={12} />
            {counts.infos}
          </button>
        </div>
        {active && (
          <div className="code-status__right">
            {/* code-editor-lsp FR-14: the server's pill; the v1 Monaco one when no server applies (TS only). */}
            <LspPill root={root} rk={rk} path={active.path} fallback={lang?.id === 'typescript' || lang?.id === 'javascript' ? <LanguagePill /> : null} />
            <span className="code-status__item">
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span className="code-status__item">{indent}</span>
            <span className="code-status__item">UTF-8</span>
            <span className="code-status__item">{active.lineEnding === 'crlf' ? 'CRLF' : 'LF'}</span>
            <span className="code-status__item">{lang?.name}</span>
          </div>
        )}
      </footer>

      {quickOpen && <QuickOpen label={files?.rootLabel ?? ''} />}
    </section>
  );
}

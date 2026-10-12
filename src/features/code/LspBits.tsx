// code-editor-lsp FR-14/FR-15/FR-16 — the language server's face in the Code tab: the
// status-bar pill (Figma 52), the trust bar above the editor (same family as the
// "Changed on disk" bar) and the start-on-show hook every editor group runs.

import { useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { EditorRoot } from '../../../contract/code-editor';
import type { LspLanguage, LspServerStatus } from '../../../contract/code-editor-lsp';
import { Button } from '../../ui/Button';
import { useCodeStore } from './codeStore';
import { lspLanguageForPath, pillView, showAction } from './lsp-status';
import { lspKey, useLspStore } from './lspStore';
import './code.css';
import './code-lsp.css';

/** FR-16: showing `path` under `root` loads the root's statuses and starts a stopped server. */
export function useLspOnShow(root: EditorRoot, rk: string, path: string | null): { language: LspLanguage | null; status: LspServerStatus | undefined; prompt: boolean } {
  const language = path ? lspLanguageForPath(path) : null;
  const key = language ? lspKey(rk, language) : '';
  const status = useLspStore((s) => (key ? s.statusByKey[key] : undefined));
  const loaded = useLspStore((s) => !!s.loadedByRootKey[rk]);
  const pending = useLspStore((s) => !!s.pendingByKey[key]);
  const dismissed = useLspStore((s) => !!s.dismissedByRootKey[rk]);
  const action = showAction(status, { dismissed, pending });

  useEffect(() => {
    if (language && !loaded) void useLspStore.getState().loadStatuses(root);
  }, [root, language, loaded]);

  useEffect(() => {
    if (action === 'start' && language) void useLspStore.getState().start(root, language);
  }, [root, language, action]);

  return { language, status, prompt: action === 'prompt' };
}

/** FR-15: "Language servers can run code from <root>" + Allow / Not now. */
export function LspTrustBar({ root, rk }: { root: EditorRoot; rk: string }): JSX.Element {
  const label = useCodeStore((s) => s.filesByRootKey[rk]?.data?.rootLabel ?? 'this root');
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    await useLspStore.getState().trust(root, true);
    setBusy(false);
  };
  return (
    <div className="code-bar code-lsp-trust" role="status">
      <ShieldAlert size={14} className="code-bar__icon" aria-hidden />
      <span className="code-bar__text">Language servers can run code from {label} (tsconfig plugins, build scripts).</span>
      <Button variant="primary" size="sm" busy={busy} onClick={() => void allow()}>
        Allow
      </Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => useLspStore.getState().dismissTrust(rk)}>
        Not now
      </Button>
    </div>
  );
}

/** FR-14: the pill for the active file's server; `fallback` (the v1 Monaco pill) when none applies. */
export function LspPill({ root, rk, path, fallback }: { root: EditorRoot; rk: string; path: string; fallback: ReactNode }): JSX.Element | null {
  const language = lspLanguageForPath(path);
  const key = language ? lspKey(rk, language) : '';
  const status = useLspStore((s) => (key ? s.statusByKey[key] : undefined));
  const progressMap = useLspStore((s) => (key ? s.progressByKey[key] : undefined));
  const view = pillView(status, progressMap ? Object.values(progressMap) : []);
  if (!view || !language || !status) return <>{fallback}</>;

  const dot = <span className={`code-status__dot code-lsp-pill__dot code-lsp-pill__dot--${view.tone}`} />;
  const cls = `code-status__item code-status__lang code-lsp-pill code-lsp-pill--${view.tone}`;
  if (!view.action) {
    return (
      <span className={cls} title={view.title}>
        {dot}
        {view.text}
      </span>
    );
  }

  const onClick = async () => {
    const store = useLspStore.getState();
    if (view.action === 'restart') return void store.start(root, language);
    // Installed since? Re-probe first (the core re-resolves on lsp_status, FR-2).
    await store.loadStatuses(root, { force: true });
    const now = useLspStore.getState().statusByKey[key];
    const hint = now?.state === 'missing' ? now.installHint : null;
    if (!hint) return;
    await navigator.clipboard?.writeText(hint).catch(() => {});
    useCodeStore.getState().setNotice(rk, `Copied “${hint}” — install ${now?.server ?? 'the server'}, then click the status pill to retry.`);
  };

  return (
    <button type="button" className={cls} title={view.title} onClick={() => void onClick()}>
      {dot}
      {view.text}
    </button>
  );
}

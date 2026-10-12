// code-editor-vsx FR-6 — the EXTENSIONS sidebar's rows: an installed extension (switch,
// ⋯ → Uninstall), a search result (Install / Installed / Needs VS Code), and the inline
// details a click expands (support badge, languages, counts, license, Open VSX, README).

import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { VsxId, VsxInstalled, VsxSummary } from '../../../contract/code-editor-vsx';
import { editorOpenTarget } from '../../lib/api';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { showToast } from '../../lib/toast';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Switch } from '../../ui/Switch';
import { Tag } from '../../ui/Tag';
import { contributionSummary, formatDownloads, supportLabel, useVsxStore, type DetailsEntry } from './vsxStore';
import './code-vsx.css';

const SUPPORT_NOTE = {
  full: 'Everything this extension contributes works here.',
  partial: "Its code doesn't run here — only its syntax highlighting, snippets and editing rules.",
  unsupported: 'It only contributes code, which needs VS Code.',
} as const;

const stop = (e: MouseEvent) => e.stopPropagation();

function ExtIcon({ src }: { src: string | null }): JSX.Element {
  return src ? (
    <img className="code-vsx__icon" src={src} alt="" />
  ) : (
    <span className="code-vsx__icon code-vsx__icon--blank">
      <Icon name="layers" size={14} />
    </span>
  );
}

function openPage(url: string): void {
  void editorOpenTarget({ target: url }).then((res) => {
    if (!res.ok) showToast(res.error.message, 'error');
  });
}

function Details({ id, entry }: { id: VsxId; entry: DetailsEntry | undefined }): JSX.Element {
  if (!entry || entry.status === 'loading') return <div className="code-vsx__details code-vsx__muted">Loading details…</div>;
  if (entry.status === 'error' || !entry.data) {
    return (
      <div className="code-vsx__details">
        <p className="code-search__error" role="alert">
          {entry.error}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void useVsxStore.getState().loadDetails(id)}>
          Retry
        </Button>
      </div>
    );
  }
  const d = entry.data;
  const counts = contributionSummary(d.contributions);
  return (
    <div className="code-vsx__details" onClick={stop}>
      {d.description && <p className="code-vsx__description">{d.description}</p>}
      <div className="code-vsx__support-line">
        <span className={`code-vsx__support code-vsx__support--${d.support}`}>{supportLabel(d.support)}</span>
        <span className="code-vsx__muted">{SUPPORT_NOTE[d.support]}</span>
      </div>
      {d.languageIds.length > 0 && (
        <div className="code-vsx__chips">
          {d.languageIds.map((l) => (
            <Tag key={l}>{l}</Tag>
          ))}
        </div>
      )}
      {counts && <p className="code-vsx__muted">{counts}</p>}
      {d.license && <p className="code-vsx__muted">License · {d.license}</p>}
      <Button variant="ghost" size="sm" className="code-vsx__link" onClick={() => openPage(d.pageUrl)}>
        <Icon name="external" size={12} />
        View on Open VSX
      </Button>
      {d.readme && <p className="code-vsx__readme">{d.readme}</p>}
    </div>
  );
}

function Row({ id, children }: { id: VsxId; children: ReactNode }): JSX.Element {
  const expanded = useVsxStore((s) => s.expanded === id);
  const entry = useVsxStore((s) => s.details[id]);
  const error = useVsxStore((s) => s.rowErrors[id]);
  const warning = useVsxStore((s) => s.warnings[id]);
  const toggle = () => void useVsxStore.getState().toggleExpanded(id);
  const onKey = (e: KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle();
    }
  };
  return (
    <div className={expanded ? 'code-vsx__item code-vsx__item--open' : 'code-vsx__item'}>
      <div className="code-vsx__row" role="button" tabIndex={0} aria-expanded={expanded} onClick={toggle} onKeyDown={onKey}>
        {children}
      </div>
      {warning && (
        <p className="code-vsx__warning" role="status">
          <Icon name="warn" size={12} />
          {warning}
        </p>
      )}
      {error && (
        <div className="code-search__error code-vsx__row-error" role="alert">
          <span>{error}</span>
          <button type="button" className="code-notice__dismiss" aria-label="Dismiss" onClick={() => useVsxStore.getState().dismissRowError(id)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {expanded && <Details id={id} entry={entry} />}
    </div>
  );
}

function MoreMenu({ ext }: { ext: VsxInstalled }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, { enabled: open, onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false) });
  return (
    <div className="code-vsx__more" ref={ref} onClick={stop}>
      <IconButton title={`More actions for ${ext.displayName}`} size={24} on={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="dots" size={14} />
      </IconButton>
      {open && (
        <div className="code-vsx__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="code-vsx__menu-item"
            onClick={() => {
              setOpen(false);
              void useVsxStore.getState().uninstall(ext.id);
            }}
          >
            Uninstall
          </button>
        </div>
      )}
    </div>
  );
}

export function InstalledRow({ ext }: { ext: VsxInstalled }): JSX.Element {
  const busy = useVsxStore((s) => s.busy[ext.id]);
  return (
    <Row id={ext.id}>
      <ExtIcon src={ext.icon} />
      <span className="code-vsx__text">
        <span className={ext.enabled ? 'code-vsx__name' : 'code-vsx__name code-vsx__name--off'}>{ext.displayName}</span>
        <span className="code-vsx__meta">
          {ext.publisher} · {ext.version}
        </span>
      </span>
      <span className="code-vsx__actions" onClick={stop}>
        <Switch
          on={ext.enabled}
          disabled={!!busy}
          label={`${ext.enabled ? 'Disable' : 'Enable'} ${ext.displayName}`}
          onChange={(on) => void useVsxStore.getState().setEnabled(ext.id, on)}
        />
        <MoreMenu ext={ext} />
      </span>
    </Row>
  );
}

export function ResultRow({ ext, installed }: { ext: VsxSummary; installed: boolean }): JSX.Element {
  const busy = useVsxStore((s) => s.busy[ext.id]);
  const support = useVsxStore((s) => s.details[ext.id]?.data?.support ?? ext.support);
  let action: ReactNode;
  if (installed) action = <span className="code-vsx__installed">Installed</span>;
  else if (support === 'unsupported')
    action = (
      <Button size="sm" disabled title="Runs code only — it needs VS Code">
        Needs VS Code
      </Button>
    );
  else
    action = (
      <Button size="sm" busy={busy === 'install'} onClick={() => void useVsxStore.getState().install(ext.id)}>
        Install
      </Button>
    );
  return (
    <Row id={ext.id}>
      <ExtIcon src={ext.icon} />
      <span className="code-vsx__text">
        <span className="code-vsx__title">
          <span className="code-vsx__name">{ext.displayName}</span>
          {ext.verified && (
            <span className="code-vsx__verified">
              <Icon name="check" size={12} title="Verified publisher" />
            </span>
          )}
        </span>
        <span className="code-vsx__meta">
          {ext.publisher}
          <span className="code-vsx__downloads" title={`${ext.downloadCount.toLocaleString()} downloads`}>
            {formatDownloads(ext.downloadCount)}
          </span>
        </span>
        {ext.description && <span className="code-vsx__summary">{ext.description}</span>}
      </span>
      <span className="code-vsx__actions" onClick={stop}>
        {action}
      </span>
    </Row>
  );
}

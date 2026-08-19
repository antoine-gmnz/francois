// design 11a ("pinned tabs, menu behind ◈") — the whole plugin surface in the
// session row: pinned tabs to the left of `◈`, every installed extension inside it.
// Nothing about plugins appears anywhere else in the chrome.
//
// The two controls on a menu row have deliberately different weights. `◈` pins or
// unpins the tab in the bar — cosmetic, reversible, a click. The switch enables the
// extension ITSELF, hooks and MCP servers and skills included, which is why it looks
// like a switch and not like a tab, and why an extension that has never been
// consented to routes through the consent dialog instead of flipping under the
// cursor (extension-install FR-16).

import { useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { ExtensionId, ExtensionInfo } from '../../../contract/extensions';
import { extensionsSetEnabled } from '../../lib/api';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore, type MainTab } from '../../lib/store';
import {
  barExtensions,
  enabledCount,
  extRowDetail,
  extTileHue,
  extTileInitials,
} from './ext-bar';
import { EMPTY_DIR_LABEL, consentControlKind, extIdFromTab, extTabId, sanitizeForDisplay } from './extensions';
import './extensions.css';

export interface ExtensionsBarMenuProps {
  /** design 10a's drop order, resolved for the current width. */
  display: 'labelled' | 'icon' | 'folded';
  mainTab: MainTab;
  /** The root the toggle writes against — the active session's, or null. */
  root: string | null;
  openExtTab: (extensionId: ExtensionId) => void;
}

/** The 2-letter identity tile every row and every tab carries. */
function Tile({ label, id, dim, size }: { label: string; id: string; dim?: boolean; size: 'tab' | 'row' }) {
  return (
    <span
      className={`ext-tile ext-tile--${size}` + (dim ? ' ext-tile--dim' : ` ext-tile--${extTileHue(id)}`)}
      aria-hidden="true"
    >
      {extTileInitials(label)}
    </span>
  );
}

export default function ExtensionsBarMenu({ display, mainTab, root, openExtTab }: ExtensionsBarMenuProps) {
  const extensions = useStore((s) => s.extensions);
  const setExtensions = useStore((s) => s.setExtensions);
  const pinnedIds = useStore((s) => s.extPinnedIds);
  const togglePin = useStore((s) => s.toggleExtPin);
  const sticky = useStore((s) => s.extStickyIds);
  const openConsentDialog = useStore((s) => s.openExtConsentDialog);
  const setExtensionsOpen = useStore((s) => s.setExtensionsOpen);
  const closeExtTab = useStore((s) => s.closeExtTab);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const alive = useMounted();

  useDismiss(rootRef, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const activeExtId = extIdFromTab(mainTab);
  const tabs = barExtensions(extensions, pinnedIds, sticky, activeExtId);
  const openTab = activeExtId ? (extensions.find((e) => e.id === activeExtId) ?? null) : null;
  const on = enabledCount(extensions);

  const toggle = (e: ExtensionInfo) => {
    // extension-install FR-16: enabling something never consented to is never a
    // single click — it goes through the dialog the modal owns.
    if (!e.enabled && consentControlKind(e.consent) !== 'toggle') {
      setOpen(false);
      openConsentDialog(e.id);
      setExtensionsOpen(true);
      return;
    }
    if (busy) return;
    setBusy(true);
    void extensionsSetEnabled({ extensionId: e.id, enabled: !e.enabled, root })
      .then((res) => {
        if (!alive.current) return;
        setBusy(false);
        if (res.ok) {
          setError(null);
          setExtensions(res.data);
        } else setError(res.error);
      })
      .catch(() => {
        if (!alive.current) return;
        setBusy(false);
        setError({ code: 'INTERNAL', message: 'Could not reach the core' });
      });
  };

  return (
    <div ref={rootRef} className="ext-bar">
      {/* The pinned tabs. At the narrowest width they are not here at all — they
          have folded into the glyph, which keeps the open one's tile so you never
          lose your place. */}
      {display !== 'folded' &&
        tabs.map((e) => {
          const current = mainTab === extTabId(e.id);
          return (
            <span
              key={e.id}
              title={`${sanitizeForDisplay(e.label)} · extension`}
              onClick={() => openExtTab(e.id)}
              className={current ? 'ext-bar__tab ext-bar__tab--on' : 'ext-bar__tab'}
            >
              <Tile label={e.label} id={e.id} size="tab" />
              {display === 'labelled' && (
                <>
                  <span className="truncate">{sanitizeForDisplay(e.label)}</span>
                  {/* FR-16's explicit close, kept: it is what kills the tab's live
                      streams. Unpinning from the menu only takes the tab out of the
                      bar; this ends it. Only on the labelled tab — at icon width
                      there is no room for two targets 16px apart. */}
                  <span
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeExtTab(e.id);
                    }}
                    title="close tab"
                    className="ext-bar__tab-close"
                  >
                    ✕
                  </span>
                </>
              )}
            </span>
          );
        })}

      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={openTab ? `${sanitizeForDisplay(openTab.label)} open · ${tabs.length} extension tabs` : 'Extensions'}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={
          'ext-bar__glyph' +
          (open ? ' ext-bar__glyph--on' : '') +
          (display === 'folded' && openTab ? ' ext-bar__glyph--carrying' : '')
        }
      >
        {display === 'folded' && openTab ? (
          <>
            <Tile label={openTab.label} id={openTab.id} size="tab" />
            <span className="ext-bar__glyph-count">{tabs.length}</span>
            <span className="ext-bar__caret">▾</span>
          </>
        ) : (
          '◈'
        )}
      </span>

      {open && (
        <div role="menu" aria-label="extensions" className="ext-bar__menu">
          <div className="ext-bar__menu-head">
            <span className="ext-bar__menu-title">Extensions</span>
            <span className="ext-bar__menu-count">{on} on</span>
            <span className="app-flex-spacer" />
            <span className="ext-bar__menu-key" title="also on the command palette">
              ⌘K
            </span>
          </div>

          {error && <div className="ext-bar__menu-error">{sanitizeForDisplay(error.message)}</div>}

          {/* `◈` renders with nothing installed too — it is the chrome's only entry
              to the Extensions modal (FR-56), and a control that disappears exactly
              when you need to find out how to get your first plugin is no control. */}
          {extensions.length === 0 && <div className="ext-bar__menu-empty">{EMPTY_DIR_LABEL}</div>}

          {extensions.map((e) => {
            const pinned = pinnedIds.includes(e.id);
            const current = mainTab === extTabId(e.id);
            return (
              <div
                key={e.id}
                role="menuitem"
                tabIndex={-1}
                className={current ? 'ext-bar__row ext-bar__row--on' : 'ext-bar__row'}
                onClick={() => {
                  if (!e.enabled) return;
                  openExtTab(e.id);
                  setOpen(false);
                }}
              >
                <Tile label={e.label} id={e.id} dim={!e.enabled} size="row" />
                <span className="ext-bar__row-body">
                  <span className={e.enabled ? 'ext-bar__row-label' : 'ext-bar__row-label ext-bar__row-label--off'}>
                    {sanitizeForDisplay(e.label)}
                  </span>
                  <span className="ext-bar__row-detail">{extRowDetail(e)}</span>
                </span>

                {/* The pin. Disabled extensions lose it entirely — the tab cannot
                    exist without the extension, so there is nothing to pin. */}
                <span
                  className={
                    'ext-bar__pin' + (pinned && e.enabled ? ' ext-bar__pin--on' : '') + (e.enabled ? '' : ' ext-bar__pin--gone')
                  }
                  title={e.enabled ? (pinned ? 'unpin from the bar' : 'pin to the bar') : undefined}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (e.enabled) togglePin(e.id);
                  }}
                >
                  ◈
                </span>

                {/* The switch. A different shape from the pin on purpose: this one
                    turns hooks, MCP servers and skills on and off with it. */}
                <span
                  role="switch"
                  aria-checked={e.enabled}
                  aria-disabled={busy}
                  title={e.enabled ? 'enabled — click to disable' : 'disabled — click to enable'}
                  className={e.enabled ? 'ext-bar__switch ext-bar__switch--on' : 'ext-bar__switch'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggle(e);
                  }}
                >
                  <span className="ext-bar__switch-knob" />
                </span>
              </div>
            );
          })}

          <div
            className="ext-bar__menu-foot"
            onClick={() => {
              setOpen(false);
              setExtensionsOpen(true);
            }}
          >
            <span className="ext-bar__menu-foot-glyph">＋</span>
            <span>Manage extensions…</span>
          </div>
        </div>
      )}
    </div>
  );
}

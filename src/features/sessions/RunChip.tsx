// The composer's run chip — redesign "Graphite & Signal", Figma "Composer"
// (128:110, "Run chip") and "20 · Run settings" (139:7373). The face reads
// `Opus 5 · low · bypass ▾` (the permission word in danger only when it is the
// risky one); clicking it opens the run settings popover — model, effort inside
// the selected model's row, permission mode — rather than the full settings
// sheet it opened before the redesign. The sheet is still one step away: the
// session header's name, the palette's "Session settings…", and the roster
// row's context menu all open it (it also carries response mode and git).

import { useLayoutEffect, useRef, useState } from 'react';
import { POPOVER_EXIT_MS, usePresence } from '../../lib/hooks/usePresence';
import type { SessionMeta } from '../../../contract/common';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { Icon } from '../../ui/Icon';
import { runChipMetricsTitle, runChipParts } from './run-chip';
import { runSettingsPlacement } from './run-settings';
import { RunSettingsPopover } from './RunSettingsPopover';
import './run-chip.css';

export interface RunChipProps {
  session: SessionMeta;
  /** The borderless 22px variant for the composer's tool strip. */
  compact?: boolean;
  /** Also run when the chip opens its popover. */
  onOpen?: () => void;
}

export default function RunChip({ session, onOpen, compact = false }: RunChipProps) {
  const parts = runChipParts(session);
  const metricsTitle = runChipMetricsTitle(session.metrics);
  const [open, setOpen] = useState(false);
  const { present, exiting } = usePresence(open, POPOVER_EXIT_MS);
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  useDismiss(rootRef, {
    onEscape: () => {
      setOpen(false);
      chipRef.current?.focus();
    },
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  // Measure after the popover renders (hidden) so its real height decides
  // whether it fits above the chip; re-place on window resize and whenever the
  // panel's own size changes (the model catalog loads in after the popover's
  // first paint, and a taller list must not leave the stale placement running
  // the panel off the bottom of the window).
  useLayoutEffect(() => {
    // Keep the placement while the popover plays its exit, drop it once gone.
    if (!present) {
      setPosition(null);
      return;
    }
    const panel = rootRef.current?.querySelector<HTMLElement>('.run-settings');
    if (!panel) return;
    const place = () => {
      const chip = chipRef.current?.getBoundingClientRect();
      if (!chip) return;
      setPosition(
        runSettingsPlacement(chip, { width: window.innerWidth, height: window.innerHeight }, { width: panel.offsetWidth, height: panel.offsetHeight }),
      );
    };
    place();
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => {
      window.removeEventListener('resize', place);
      observer.disconnect();
    };
  }, [present, session.model.id, session.permissionMode]);

  const toggle = () => {
    setOpen((v) => !v);
    if (!open) onOpen?.();
  };

  return (
    <div ref={rootRef} className={compact ? 'run-chip run-chip--compact' : 'run-chip'}>
      <button
        ref={chipRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${parts.model} · ${parts.mode}${parts.response ? ` · ${parts.response}` : ''}${metricsTitle ? ` · ${metricsTitle}` : ''} — model, effort and permissions`}
        onClick={toggle}
        className={open ? 'run-chip__chip run-chip__chip--open' : 'run-chip__chip'}
      >
        <span className="run-chip__model">{parts.model}</span>
        {parts.effort && <span className="run-chip__effort-tag">{parts.effort}</span>}
        <span className={parts.danger ? 'run-chip__mode run-chip__mode--danger' : 'run-chip__mode'}>{parts.mode}</span>
        {/* response-mode FR-15: last in the cluster, and only when it is not
            'default' — the common case leaves the chip exactly as wide as it was. */}
        {parts.response && <span className="run-chip__response">{parts.response}</span>}
        <Icon name="chevron-down" size={10} className="run-chip__caret" />
      </button>
      {present && <RunSettingsPopover session={session} position={position} exiting={exiting} onClose={() => setOpen(false)} />}
    </div>
  );
}

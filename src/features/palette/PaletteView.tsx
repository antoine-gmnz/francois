// Command palette — redesign "Graphite & Signal", Figma "10 · Command palette"
// (136:5213, light 142:12392): a search row that names the session it acts on,
// results grouped Best match / Session / Go to / App with an icon, a hint and —
// where one exists — the single-key shortcut, and a keycap footer. The grouping,
// icons and keycaps come from palette-presentation.ts; this file only renders.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PaletteCommand, SecondaryStep, SecondaryStepItem } from '../../../contract/command-palette';
import { closePalette, filterRank, makeContext, paletteCommands, usePaletteState, useToastState } from './palette';
import { commandLook, flattenSections, paletteSections } from './palette-presentation';
import { getPaletteRunningAgents, usePaletteDataRev } from './paletteData';
import { focusedSessionId } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { Kbd } from '../../ui/Kbd';
import { ListRow } from '../../ui/ListRow';
import './palette.css';

// ---------- palette overlay + toast host (rendered once at the app root) ----------

export default function PaletteRoot() {
  const open = usePaletteState((s) => s.open);
  return (
    <>
      {open && <Palette />}
      <ToastHost />
    </>
  );
}

function Palette() {
  const mode = usePaletteState((s) => s.mode);
  const query = usePaletteState((s) => s.query);
  const selectedIndex = usePaletteState((s) => s.selectedIndex);
  const secondaryStep = usePaletteState((s) => s.secondaryStep);
  const secondaryQuery = usePaletteState((s) => s.secondaryQuery);
  const secondarySelectedIndex = usePaletteState((s) => s.secondarySelectedIndex);
  const setQuery = usePaletteState((s) => s.setQuery);
  const setSecondaryQuery = usePaletteState((s) => s.setSecondaryQuery);
  const setSelectedIndex = usePaletteState((s) => s.setSelectedIndex);
  const setSecondarySelectedIndex = usePaletteState((s) => s.setSecondarySelectedIndex);
  const secondaryParentName = usePaletteState((s) => s.secondaryParentName);
  const enterSecondary = usePaletteState((s) => s.enterSecondary);
  const popToRoot = usePaletteState((s) => s.popToRoot);

  // split-session FR-7: every session-scoped command targets the FOCUSED pane's
  // session — which equals activeSessionId whenever the app is not split.
  const activeSessionId = useStore((s) => focusedSessionId(s));
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render when the palette-data caches (agents/skills/diff/models) or the active
  // session's token count change, so the per-render context/hints stay live (FR-9).
  usePaletteDataRev((s) => s.rev);
  useStore((s) => s.sessions.find((x) => x.id === focusedSessionId(s))?.contextUsedTokens);

  // Fresh context every render pass while open (FR-9).
  const ctx = makeContext(activeSessionId, getPaletteRunningAgents(activeSessionId).length);

  // The ranked list regrouped into sections — and re-flattened, so the cursor
  // walks exactly the order the sections are drawn in.
  const rootItems = useMemo(() => {
    const enabled = paletteCommands().filter((c) => !c.enabled || c.enabled(ctx));
    const ranked = filterRank(enabled, query, (c) => c.name);
    return flattenSections(paletteSections(ranked, query, (c) => c.id));
  }, [query, ctx.activeSessionId, ctx.runningAgentCount]);
  const scopeName = useStore((s) => s.sessions.find((x) => x.id === activeSessionId)?.name ?? null);

  const secItems = useMemo(
    () => (secondaryStep ? filterRank(secondaryStep.items, secondaryQuery, (i) => i.label) : []),
    [secondaryStep, secondaryQuery],
  );

  const isSecondary = mode === 'secondary';
  const items: (PaletteCommand | SecondaryStepItem)[] = isSecondary ? secItems : rootItems;
  const rawSel = isSecondary ? secondarySelectedIndex : selectedIndex;
  // clamp into range — the filtered set can shrink for reasons other than a query edit
  // (an enabled-command dropping out, a smaller secondary list) leaving a stale index.
  const selIdx = items.length === 0 ? 0 : Math.min(Math.max(rawSel, 0), items.length - 1);
  const setSel = isSecondary ? setSecondarySelectedIndex : setSelectedIndex;

  // Autofocus the input on open (FR-2) and keep focus across the mode swap.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isSecondary]);

  const currentText = isSecondary ? secondaryQuery : query;

  // Keep the keyboard cursor's row in view as ↑↓ walk past the list's scroll cap.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.list-row--selected');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selIdx, isSecondary]);

  const runCommand = (cmd: PaletteCommand) => {
    const result = cmd.run(ctx);
    if (result) enterSecondary(result as SecondaryStep, cmd.name); // FR-16
    else closePalette();
  };

  const pickItem = (item: SecondaryStepItem) => {
    secondaryStep?.onPick(item.id); // FR-13/FR-17
    if (usePaletteState.getState().secondaryStep === secondaryStep) closePalette();
  };

  const activate = () => {
    const sel = items[selIdx];
    if (!sel) return;
    if (isSecondary) pickItem(sel as SecondaryStepItem);
    else runCommand(sel as PaletteCommand);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) setSel((selIdx + 1) % items.length); // wrap (FR-12)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setSel((selIdx - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(); // FR-13
    } else if (e.key === 'Backspace' && isSecondary && secondaryQuery === '') {
      e.preventDefault();
      popToRoot(); // FR-15
    }
    // Escape / ⌘K are handled by app-shell's capture-phase listener (FR-1/FR-3).
  };

  // rootItems is already in section order, so regrouping it keeps every item in its place.
  const sectionsFor = isSecondary ? null : paletteSections(rootItems, query, (c) => c.id);

  return (
    <div className="palette-backdrop" onMouseDown={() => closePalette()}>
      <div className="palette-panel" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        {/* input row — Figma 136:5214: search icon, the query, the scope on the right */}
        <div className="palette-input-row">
          <Icon name="search" size={16} className="palette-input-row__icon" />
          {isSecondary && secondaryStep && <span className="palette-parent-pill">{secondaryParentName}</span>}
          <input
            ref={inputRef}
            className="palette-input"
            value={currentText}
            onChange={(e) => (isSecondary ? setSecondaryQuery(e.target.value) : setQuery(e.target.value))}
            onKeyDown={onKeyDown}
            aria-label={isSecondary && secondaryStep ? secondaryStep.placeholder : 'Run a command'}
            placeholder={isSecondary && secondaryStep ? secondaryStep.placeholder : 'Run a command…'}
          />
          {scopeName && <span className="palette-scope truncate">in {scopeName}</span>}
        </div>

        {/* results — Figma 136:5222 */}
        <div ref={listRef} className="scz palette-list" role="listbox" aria-label="Commands">
          {items.length === 0 ? (
            <div className="palette-empty">No matching commands</div>
          ) : sectionsFor ? (
            sectionsFor.map((section) => (
              <div key={section.id} role="group" aria-label={section.label}>
                <div className="palette-section-label">{section.label}</div>
                {section.items.map((cmd) => {
                  const i = items.indexOf(cmd);
                  return (
                    <CommandRow key={cmd.id} cmd={cmd} selected={i === selIdx} onHover={() => setSel(i)} onClick={() => runCommand(cmd)} />
                  );
                })}
              </div>
            ))
          ) : (
            items.map((it, i) => (
              <ItemRow key={(it as SecondaryStepItem).id} item={it as SecondaryStepItem} selected={i === selIdx} onHover={() => setSel(i)} onClick={() => pickItem(it as SecondaryStepItem)} />
            ))
          )}
        </div>

        {/* footer — Figma 136:5293 */}
        <div className="palette-footer">
          <span className="palette-footer__hint">
            <Kbd keys="↑↓" /> navigate
          </span>
          <span className="palette-footer__hint">
            <Kbd keys="⏎" /> {isSecondary ? 'select' : 'run'}
          </span>
          <span className="palette-footer__hint">
            <Kbd keys="Esc" /> {isSecondary ? 'back' : 'close'}
          </span>
        </div>
      </div>
    </div>
  );
}

function CommandRow({ cmd, selected, onHover, onClick }: { cmd: PaletteCommand; selected: boolean; onHover: () => void; onClick: () => void }) {
  const look = commandLook(cmd.id);
  return (
    <Row icon={look.icon} name={cmd.name} hint={cmd.hint?.()} keycap={look.keycap} selected={selected} onHover={onHover} onClick={onClick} />
  );
}

function ItemRow({ item, selected, onHover, onClick }: { item: SecondaryStepItem; selected: boolean; onHover: () => void; onClick: () => void }) {
  return <Row name={item.label} hint={item.hint} selected={selected} onHover={onHover} onClick={onClick} />;
}

function Row({
  icon,
  name,
  hint,
  keycap,
  selected,
  onHover,
  onClick,
}: {
  icon?: IconName;
  name: string;
  hint?: string;
  keycap?: string;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <ListRow className="palette-row" role="option" aria-selected={selected} selected={selected} onMouseEnter={onHover} onClick={onClick}>
      {icon && <Icon name={icon} size={15} className="palette-row__icon" />}
      <span className="palette-row__name truncate">{name}</span>
      <span className="palette-row__hint truncate">{hint ?? ''}</span>
      {keycap && <Kbd keys={keycap} />}
    </ListRow>
  );
}

// ---------- toasts (FR-24/FR-25) ----------

const TOAST_ICON: Record<string, IconName> = { error: 'x', info: 'info', success: 'check' };

function ToastHost() {
  const visible = useToastState((s) => s.visible);
  const dismiss = useToastState((s) => s.dismiss);
  if (visible.length === 0) return null;
  return (
    <div className="palette-toast-host">
      {visible.map((t) => {
        const kind = t.kind in TOAST_ICON ? t.kind : 'info';
        return (
          <div key={t.id} role="status" className={`palette-toast palette-toast--${kind}`} onClick={() => dismiss(t.id)}>
            <Icon name={TOAST_ICON[kind]!} size={12} className="palette-toast__icon" />
            <span className="palette-toast__message">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

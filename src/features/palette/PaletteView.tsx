import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PaletteCommand, SecondaryStep, SecondaryStepItem } from '../../../contract/command-palette';
import { closePalette, filterRank, makeContext, paletteCommands, usePaletteState, useToastState } from './palette';
import { getPaletteRunningAgents, usePaletteDataRev } from './paletteData';
import { useStore } from '../../lib/store';
import { ListRow } from '../../ui/ListRow';
import { HintBar } from '../../ui/HintBar';
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

  const activeSessionId = useStore((s) => s.activeSessionId);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render when the palette-data caches (agents/skills/diff/models) or the active
  // session's token count change, so the per-render context/hints stay live (FR-9).
  usePaletteDataRev((s) => s.rev);
  useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.contextUsedTokens);

  // Fresh context every render pass while open (FR-9).
  const ctx = makeContext(activeSessionId, getPaletteRunningAgents(activeSessionId).length);

  const rootItems = useMemo(() => {
    const enabled = paletteCommands().filter((c) => !c.enabled || c.enabled(ctx));
    return filterRank(enabled, query, (c) => c.name);
  }, [query, ctx.activeSessionId, ctx.runningAgentCount]);

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

  // Block caret (§8): measure the current text width via a hidden mirror and place a
  // blinking block at its end; the native caret is hidden. JetBrains Mono is monospace,
  // so this is exact for the short, non-overflowing queries the palette handles.
  const currentText = isSecondary ? secondaryQuery : query;
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [caretX, setCaretX] = useState(0);
  useLayoutEffect(() => {
    setCaretX(mirrorRef.current?.offsetWidth ?? 0); // measure before paint — no one-frame lag
  }, [currentText, isSecondary]);

  const runCommand = (cmd: PaletteCommand) => {
    const result = cmd.run(ctx);
    if (result) enterSecondary(result as SecondaryStep, cmd.name); // FR-16
    else closePalette();
  };

  const pickItem = (item: SecondaryStepItem) => {
    secondaryStep?.onPick(item.id); // FR-13/FR-17
    closePalette();
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

  return (
    <div className="palette-backdrop" onMouseDown={() => closePalette()}>
      <div className="palette-panel" onMouseDown={(e) => e.stopPropagation()}>
        {/* input row */}
        <div className="palette-input-row">
          <span className="palette-chevron">›</span>
          {isSecondary && secondaryStep && <span className="palette-parent-pill">{secondaryParentName}</span>}
          <div className="palette-input-wrap">
            <input
              ref={inputRef}
              className="palette-input"
              value={currentText}
              onChange={(e) => (isSecondary ? setSecondaryQuery(e.target.value) : setQuery(e.target.value))}
              onKeyDown={onKeyDown}
              placeholder={isSecondary && secondaryStep ? secondaryStep.placeholder : 'run a command'}
            />
            <span ref={mirrorRef} aria-hidden className="palette-mirror">
              {currentText}
            </span>
            <span aria-hidden className="palette-caret" style={{ '--caret-x': `${caretX}px` } as CSSProperties} />
          </div>
          <span className="palette-esc-hint">{isSecondary ? 'back' : 'esc'}</span>
        </div>

        {/* list */}
        <div className="scz palette-list">
          {items.length === 0 ? (
            <div className="palette-empty">no matching commands</div>
          ) : (
            items.map((it, i) =>
              isSecondary ? (
                <ItemRow key={(it as SecondaryStepItem).id} item={it as SecondaryStepItem} selected={i === selIdx} onHover={() => setSel(i)} onClick={() => pickItem(it as SecondaryStepItem)} />
              ) : (
                <CommandRow key={(it as PaletteCommand).id} cmd={it as PaletteCommand} selected={i === selIdx} onHover={() => setSel(i)} onClick={() => runCommand(it as PaletteCommand)} />
              ),
            )
          )}
        </div>

        {/* footer */}
        <HintBar
          items={[
            { key: '↑↓', label: 'navigate' },
            { key: '⏎', label: isSecondary ? 'select' : 'run' },
            { key: 'esc', label: isSecondary ? 'back' : 'dismiss' },
          ]}
        />
      </div>
    </div>
  );
}

function CommandRow({ cmd, selected, onHover, onClick }: { cmd: PaletteCommand; selected: boolean; onHover: () => void; onClick: () => void }) {
  return (
    <Row
      glyph={cmd.glyph}
      name={cmd.name}
      hint={cmd.hint?.()}
      selected={selected}
      onHover={onHover}
      onClick={onClick}
    />
  );
}

function ItemRow({ item, selected, onHover, onClick }: { item: SecondaryStepItem; selected: boolean; onHover: () => void; onClick: () => void }) {
  return <Row glyph="" name={item.label} hint={item.hint} selected={selected} onHover={onHover} onClick={onClick} />;
}

function Row({ glyph, name, hint, selected, onHover, onClick }: { glyph: string; name: string; hint?: string; selected: boolean; onHover: () => void; onClick: () => void }) {
  return (
    <ListRow className="palette-row" selected={selected} onMouseEnter={onHover} onClick={onClick}>
      <span className="palette-row-glyph">{glyph}</span>
      <span className="palette-row-name">{name}</span>
      <span className="palette-row-hint">{hint ?? ''}</span>
    </ListRow>
  );
}

// ---------- toasts (FR-24/FR-25) ----------

const TOAST_GLYPH: Record<string, { glyph: string; color: string; border: string }> = {
  error: { glyph: '✕', color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 40%, transparent)' },
  info: { glyph: '●', color: 'var(--text-dim)', border: '1px solid var(--bg-hover-2)' },
  success: { glyph: '●', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 40%, transparent)' },
};

function ToastHost() {
  const visible = useToastState((s) => s.visible);
  const dismiss = useToastState((s) => s.dismiss);
  if (visible.length === 0) return null;
  return (
    <div className="palette-toast-host">
      {visible.map((t) => {
        const g = TOAST_GLYPH[t.kind] ?? TOAST_GLYPH.info;
        return (
          <div key={t.id} className="palette-toast" onClick={() => dismiss(t.id)}>
            <span className="palette-toast-glyph" style={{ '--toast-color': g.color, '--toast-border': g.border } as CSSProperties}>
              {g.glyph}
            </span>
            <span className="palette-toast-message">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

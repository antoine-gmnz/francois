import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaletteCommand, SecondaryStep, SecondaryStepItem } from '../contract/command-palette';
import { closePalette, filterRank, makeContext, paletteCommands, usePaletteState, useToastState } from './palette';
import { getPaletteRunningAgents, usePaletteDataRev } from './paletteData';
import { useStore } from './store';

const C = {
  accent: '#c8a15a',
  text: '#d3d6dc',
  name: '#c4c7ce',
  bright: '#dfe2e8',
  glyph: '#868a93',
  hint: '#565a63',
  faint: '#565a63',
  pill: '#26282f',
  pillText: '#a9adb6',
  border: '#24262d',
  add: '#7fa07a',
  del: '#c46b62',
};

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
  useEffect(() => {
    setCaretX(mirrorRef.current?.offsetWidth ?? 0);
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
    <div
      onMouseDown={() => closePalette()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,7,9,0.62)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 118,
        zIndex: 1000,
        animation: 'fadeIn 120ms ease-out',
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(588px, calc(100vw - 32px))',
          background: '#191b21',
          border: '1px solid #34363f',
          borderRadius: 8,
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
          overflow: 'hidden',
          animation: 'palettePop 120ms ease-out',
        }}
      >
        {/* input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.accent, fontSize: 15 }}>›</span>
          {isSecondary && secondaryStep && (
            <span style={{ fontSize: 10, color: C.pillText, background: C.pill, borderRadius: 8, padding: '1px 6px', flexShrink: 0 }}>
              {secondaryParentName}
            </span>
          )}
          <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
            <input
              ref={inputRef}
              value={currentText}
              onChange={(e) => (isSecondary ? setSecondaryQuery(e.target.value) : setQuery(e.target.value))}
              onKeyDown={onKeyDown}
              placeholder={isSecondary && secondaryStep ? secondaryStep.placeholder : 'run a command'}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 14,
                color: C.text,
                caretColor: 'transparent',
              }}
            />
            <span ref={mirrorRef} aria-hidden style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: 'inherit', fontSize: 14, left: 0 }}>
              {currentText}
            </span>
            <span
              aria-hidden
              style={{ position: 'absolute', left: caretX, width: 8, height: 16, background: C.accent, animation: 'blink 1s step-end infinite', pointerEvents: 'none' }}
            />
          </div>
          <span style={{ fontSize: 10, color: C.faint }}>{isSecondary ? 'back' : 'esc'}</span>
        </div>

        {/* list */}
        <div className="scz" style={{ padding: 6, maxHeight: 336, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 13, color: C.faint, textAlign: 'center' }}>no matching commands</div>
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
        <div style={{ display: 'flex', gap: 16, padding: '9px 16px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.faint }}>
          <FooterHint k="↑↓" label="navigate" />
          <FooterHint k="⏎" label={isSecondary ? 'select' : 'run'} />
          <FooterHint k="esc" label={isSecondary ? 'back' : 'dismiss'} />
        </div>
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
    <div
      onMouseEnter={onHover}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 5,
        cursor: 'pointer',
        background: selected ? C.pill : 'transparent',
      }}
    >
      <span style={{ width: 16, textAlign: 'center', fontSize: 12, color: selected ? C.accent : C.glyph, flexShrink: 0 }}>{glyph}</span>
      <span style={{ fontSize: 13, color: selected ? C.bright : C.name, flexShrink: 0 }}>{name}</span>
      <span style={{ fontSize: 11, color: C.hint, flex: 1, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint ?? ''}</span>
    </div>
  );
}

function FooterHint({ k, label }: { k: string; label: string }) {
  return (
    <span>
      <span style={{ color: C.glyph }}>{k}</span> {label}
    </span>
  );
}

// ---------- toasts (FR-24/FR-25) ----------

const TOAST_GLYPH: Record<string, { glyph: string; color: string; border: string }> = {
  error: { glyph: '✕', color: '#c46b62', border: '1px solid rgba(196,107,98,0.4)' },
  info: { glyph: '●', color: '#868a93', border: '1px solid #34363f' },
  success: { glyph: '●', color: '#7fa07a', border: '1px solid rgba(127,160,122,0.4)' },
};

function ToastHost() {
  const visible = useToastState((s) => s.visible);
  const dismiss = useToastState((s) => s.dismiss);
  if (visible.length === 0) return null;
  return (
    <div style={{ position: 'fixed', bottom: 48, left: 0, right: 0, display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 8, zIndex: 1100, pointerEvents: 'none' }}>
      {visible.map((t) => {
        const g = TOAST_GLYPH[t.kind] ?? TOAST_GLYPH.info;
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#1b1d23',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 12,
              color: C.bright,
              boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
              cursor: 'pointer',
              animation: 'toastIn 140ms ease-out',
              maxWidth: 'min(520px, calc(100vw - 40px))',
            }}
          >
            <span style={{ width: 12, textAlign: 'center', fontSize: 11, color: g.color, border: g.border, borderRadius: '50%', lineHeight: '14px', height: 14, boxSizing: 'content-box' }}>
              {g.glyph}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

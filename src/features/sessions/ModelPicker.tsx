import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelInfo } from '../../../contract/common';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { groupByFamily, modelPickerPlacement, revealModelOption } from './model-picker';
import './model-picker.css';

export default function ModelPicker({
  models,
  modelId,
  onChange,
  loading,
  providerHeading,
}: {
  models: ModelInfo[];
  modelId: string;
  onChange: (id: string) => void;
  loading: boolean;
  /**
   * multi-provider-openai FR-21: the neutral group heading above the family
   * list — the selected account's own label (design brief §5: text only, no
   * chip, no accent, no icon). Empty renders no heading.
   */
  providerHeading: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyboardModel, setKeyboardModel] = useState('');
  const listId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [rect, setRect] = useState<ReturnType<typeof modelPickerPlacement> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = models.find((m) => m.id === modelId) ?? null;

  const families = useMemo(() => groupByFamily(models), [models]);

  useLayoutEffect(() => {
    if (open && rootRef.current) revealModelOption(rootRef.current);
  }, [open, keyboardModel]);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setRect(modelPickerPlacement(r, window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [open]);

  const disabled = models.length === 0;

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect(modelPickerPlacement(r, window.innerWidth, window.innerHeight));
    const first = selected ?? models[0];
    setKeyboardModel(first?.id ?? '');
    setHovered(first ? groupByFamily([first])[0].family : null);
    setOpen(true);
  };

  useDismiss(rootRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { toggle(); return; }
      const index = models.findIndex(m => m.id === keyboardModel);
      const next = models[(index + (event.key === 'ArrowDown' ? 1 : -1) + models.length) % models.length];
      setKeyboardModel(next.id);
      setHovered(groupByFamily([next])[0].family);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) toggle();
      else if (models.some(m => m.id === keyboardModel)) { onChange(keyboardModel); setOpen(false); }
    }
  };

  return (
    <div ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && keyboardModel ? `${listId}-${keyboardModel}` : undefined}
        ref={triggerRef}
        onClick={toggle}
        className={`model-picker__trigger${disabled ? ' model-picker__trigger--disabled' : ''}`}
      >
        <span className={`model-picker__trigger-label${selected ? ' model-picker__trigger-label--selected' : ''}`}>
          {selected ? selected.label : loading ? 'Select a model' : models.length === 0 ? 'No models available' : 'Select a model'}
        </span>
        <span className="model-picker__caret">▾</span>
      </button>

      {selected?.brief && !open && <div className="model-picker__brief">{selected.brief}</div>}

      {open && rect && (
        <div
          id={listId}
          role="listbox"
          aria-label="Models"
          className="model-picker__panel model-picker__popover"
          style={rect}
        >
          <div className="model-picker__provider-heading">{providerHeading}</div>
          <div className="model-picker__families scz">
            {families.map(({ family, items }) => {
              const active = hovered === family;
              const familySelected = items.some((m) => m.id === modelId);
              return (
                <div
                  key={family}
                  onMouseEnter={() => setHovered(family)}
                  className={`model-picker__family${active ? ' model-picker__family--active' : ''}${familySelected ? ' model-picker__family--selected' : ''}`}
                >
                  <span
                    className={`model-picker__family-label${familySelected ? ' model-picker__family-label--selected' : ''}`}
                  >
                    {family}
                  </span>
                  <span className="model-picker__family-caret">{items.length > 1 ? `${items.length} ` : ''}›</span>
                </div>
              );
            })}
          </div>
          <div className="scz model-picker__submenu">
            {families.find(({ family }) => family === hovered)?.items.map((m) => {
              const isSel = m.id === modelId;
              return (
                <div
                  key={m.id}
                  id={`${listId}-${m.id}`}
                  role="option"
                  aria-selected={isSel}
                  title={m.id}
                  onMouseEnter={() => setKeyboardModel(m.id)}
                  onClick={() => { onChange(m.id); setOpen(false); }}
                  className={`model-picker__option${keyboardModel === m.id ? ' model-picker__option--focused' : ''}${isSel ? ' model-picker__option--selected' : ''}`}
                >
                  <div className={`model-picker__option-label${isSel ? ' model-picker__option-label--selected' : ''}`}>{m.label}</div>
                  {m.brief && <div className="model-picker__option-brief">{m.brief}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../../../contract/common';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { groupByFamily } from './model-picker';
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
  providerHeading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const selected = models.find((m) => m.id === modelId) ?? null;

  const families = useMemo(() => groupByFamily(models), [models]);

  const disabled = loading || models.length === 0;

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    setHovered(families[0]?.family ?? null);
    setOpen(true);
  };

  useDismiss(rootRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  return (
    <div ref={rootRef}>
      <div
        ref={triggerRef}
        onClick={toggle}
        className={`model-picker__trigger${disabled ? ' model-picker__trigger--disabled' : ''}`}
      >
        <span className={`model-picker__trigger-label${selected ? ' model-picker__trigger-label--selected' : ''}`}>
          {loading ? 'loading…' : models.length === 0 ? 'no models available' : selected ? selected.label : 'select a model'}
        </span>
        <span className="model-picker__caret">▾</span>
      </div>

      {selected?.brief && !open && <div className="model-picker__brief">{selected.brief}</div>}

      {open && rect && (
        <div
          className="model-picker__panel model-picker__popover"
          style={{ top: rect.top, left: rect.left, width: rect.width }}
        >
          {providerHeading && <div className="model-picker__provider-heading">{providerHeading}</div>}
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

                {active && (
                  <div className="scz model-picker__panel model-picker__submenu">
                    {items.map((m) => {
                      const isSel = m.id === modelId;
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            onChange(m.id);
                            setOpen(false);
                          }}
                          className={`model-picker__option${isSel ? ' model-picker__option--selected' : ''}`}
                        >
                          <div className={`model-picker__option-label${isSel ? ' model-picker__option-label--selected' : ''}`}>
                            {m.label}
                          </div>
                          {m.brief && <div className="model-picker__option-brief">{m.brief}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

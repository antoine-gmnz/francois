import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Star } from 'lucide-react';
import type { ModelInfo } from '../../../contract/common';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { filterModelInfos, groupByFamily, modelPickerPlacement, revealModelOption, sortFavoritesFirst, type ModelFamilyGroup } from './model-picker';
import './model-picker.css';

export default function ModelPicker({
  models,
  modelId,
  onChange,
  loading,
  providerHeading,
  groupBy = groupByFamily,
  searchable = false,
  emptyMessage,
  isFavorite,
  onToggleFavorite,
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
  /**
   * pi-models-metrics FR-1: defaults to family grouping (existing consumers,
   * unchanged). A Pi caller passes `groupByProvider` from `runtime-model.ts` —
   * two providers advertising the same modelId must stay distinct groups,
   * which family/label grouping alone cannot tell apart.
   */
  groupBy?: (models: ModelInfo[]) => ModelFamilyGroup[];
  /** pi-models-metrics (design brief §Flows): "Search provider and model labels." */
  searchable?: boolean;
  /** pi-models-metrics FR-1: overrides the trigger's "No models available" copy. */
  emptyMessage?: string;
  /** pi-models-metrics (design brief §Flows): favorites are a UI preference — the
   *  caller owns storage (runtime-model-favorites.ts); omitted ⇒ no star affordance. */
  isFavorite?: (model: ModelInfo) => boolean;
  onToggleFavorite?: (model: ModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keyboardModel, setKeyboardModel] = useState('');
  const [query, setQuery] = useState('');
  const listId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [rect, setRect] = useState<ReturnType<typeof modelPickerPlacement> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = models.find((m) => m.id === modelId) ?? null;

  const visibleModels = useMemo(
    () => (searchable && query.trim() !== '' ? filterModelInfos(models, query) : models),
    [models, query, searchable],
  );
  const families = useMemo(() => groupBy(visibleModels), [visibleModels, groupBy]);

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

  // pi-models-metrics (design brief §Flows): focus lands in the search box the
  // moment the panel opens, so typing starts filtering immediately.
  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  const disabled = models.length === 0;

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect(modelPickerPlacement(r, window.innerWidth, window.innerHeight));
    setQuery('');
    const first = selected ?? models[0];
    setKeyboardModel(first?.id ?? '');
    setHovered(first ? groupBy([first])[0].family : null);
    setOpen(true);
  };

  useDismiss(rootRef, {
    onEscape: () => setOpen(false),
    onOutsideClick: () => setOpen(false),
    enabled: open,
  });

  const selectIfAvailable = (id: string) => {
    const target = visibleModels.find((m) => m.id === id);
    if (!target || target.descriptor?.availability === 'unavailable') return;
    onChange(id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disabled) return;
    // pi-models-metrics: a plain space is text INSIDE the search box, not a
    // select — everything else about this handler is unchanged, including
    // Space-to-select for every pre-existing, non-searchable consumer.
    const inSearch = searchable && event.target === searchRef.current;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { toggle(); return; }
      if (visibleModels.length === 0) return;
      const index = visibleModels.findIndex(m => m.id === keyboardModel);
      const next = visibleModels[(index + (event.key === 'ArrowDown' ? 1 : -1) + visibleModels.length) % visibleModels.length];
      setKeyboardModel(next.id);
      setHovered(groupBy([next])[0].family);
    } else if (event.key === 'Enter' || (event.key === ' ' && !inSearch)) {
      event.preventDefault();
      if (!open) toggle();
      else selectIfAvailable(keyboardModel);
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
          {selected ? selected.label : loading ? 'Select a model' : models.length === 0 ? (emptyMessage ?? 'No models available') : 'Select a model'}
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
          {(providerHeading || searchable) && (
            // Grouped under one grid item spanning row 1 — the families/submenu
            // pair below it stays exactly the two-column, single-row layout it
            // was before the search box existed (families/submenu occupy row 2
            // either way; nothing shifts for a non-searchable caller).
            <div className="model-picker__header">
              {providerHeading && <div className="model-picker__provider-heading">{providerHeading}</div>}
              {searchable && (
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models…"
                  className="model-picker__search"
                />
              )}
            </div>
          )}
          <div className="model-picker__families scz">
            {families.length === 0 && <div className="model-picker__empty">No matches</div>}
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
            {(() => {
              const items = families.find(({ family }) => family === hovered)?.items ?? [];
              const ordered = isFavorite ? sortFavoritesFirst(items, isFavorite) : items;
              return ordered.map((m) => {
                const isSel = m.id === modelId;
                // pi-models-metrics FR-3: a saved/default/favorite selection whose
                // pair vanished stays visible with its exact identity — disabled,
                // never dropped and never silently swapped for another model.
                const unavailable = m.descriptor?.availability === 'unavailable';
                return (
                  <div
                    key={m.id}
                    id={`${listId}-${m.id}`}
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={unavailable || undefined}
                    title={m.id}
                    onMouseEnter={() => setKeyboardModel(m.id)}
                    onClick={() => selectIfAvailable(m.id)}
                    className={`model-picker__option${keyboardModel === m.id ? ' model-picker__option--focused' : ''}${isSel ? ' model-picker__option--selected' : ''}${unavailable ? ' model-picker__option--unavailable' : ''}`}
                  >
                    <div className="model-picker__option-row">
                      <div className={`model-picker__option-label${isSel ? ' model-picker__option-label--selected' : ''}`}>{m.label}</div>
                      {onToggleFavorite && (
                        <button
                          type="button"
                          aria-pressed={isFavorite?.(m) ?? false}
                          aria-label={isFavorite?.(m) ? 'Remove from favorites' : 'Add to favorites'}
                          onClick={(e) => { e.stopPropagation(); onToggleFavorite(m); }}
                          className={`model-picker__favorite${isFavorite?.(m) ? ' model-picker__favorite--on' : ''}`}
                        >
                          <Star size={12} fill={isFavorite?.(m) ? 'currentColor' : 'none'} />
                        </button>
                      )}
                    </div>
                    {m.brief && <div className="model-picker__option-brief">{m.brief}</div>}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

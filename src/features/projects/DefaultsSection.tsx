// projects — the project settings' Session defaults tab: one select per
// default, two to a row in the settings field style, disabled while the root is
// missing (FR-38). Every change commits at once (FR-35).

import type { ProjectDefaults } from '../../../contract/common';
import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import { SettingsField, SettingsSelect } from '../../ui/Settings';
import { InlineError } from './InlineError';
import { defaultsSelectValue, fieldDefsShowModelSelect, piRuntimeModelDefaultLabel, type DefaultFieldDef, type DefaultsKey } from './projects';

/** The catalog's labels are lower-case (`permission mode`); a field label is not. */
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function DefaultsSection({
  catalogState,
  fieldDefs,
  defaults,
  onCommit,
  error,
  disabled,
}: {
  catalogState: ModelCatalogState;
  fieldDefs: DefaultFieldDef[];
  defaults: ProjectDefaults;
  onCommit: (key: DefaultsKey, value: string) => void;
  error: string | null;
  disabled: boolean;
}) {
  // pr-142 §C1: gated on the SAME predicate that hides the selects below —
  // not on whether `runtimeModel` happens to still be saved.
  const piModelLabel = fieldDefsShowModelSelect(fieldDefs) ? null : piRuntimeModelDefaultLabel(defaults);

  return (
    <div className={disabled ? 'pj-form is-disabled' : 'pj-form'}>
      <ModelCatalogStatus state={catalogState} />
      <div className="pj-form-grid">
        {/* pi-models-metrics FR-4: a saved Pi model pair shows read-only — the
            selects below cannot represent it, and it never appears in the patch. */}
        {piModelLabel && (
          <SettingsField label="Model (pi)">
            <span className="settings-input pj-readonly" title="Saved Pi model · Unavailable">
              {piModelLabel} · Unavailable
            </span>
          </SettingsField>
        )}
        {fieldDefs.map((field) => {
          const value = defaultsSelectValue(defaults, field.key);
          // §7 case 22: a stored default the catalog no longer offers has no
          // matching <option> — surface it instead of silently rendering `inherit`.
          const stale = value !== '' && !field.options.some((o) => o.value === value);
          const tone = value === '' ? 'settings-input--unset' : stale ? 'settings-input--error' : undefined;
          return (
            <SettingsField key={field.key} label={sentenceCase(field.label)}>
              <SettingsSelect className={tone} value={value} disabled={disabled} onChange={(e) => onCommit(field.key, e.target.value)}>
                {stale && <option disabled value={value}>{`${value} · Not in the current catalogue`}</option>}
                {field.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {o.label}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsField>
          );
        })}
      </div>
      {error !== null && <InlineError>{error}</InlineError>}
    </div>
  );
}

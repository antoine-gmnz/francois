import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
// projects — ProjectsModal's SESSION DEFAULTS group: five uniform selects,
// disabled while the root is missing (FR-38). Split out of ProjectsModal's
// `{selected && (...)}` block per REFACTOR.md §6c.

import type { ProjectDefaults } from '../../../contract/common';
import { InlineError } from './InlineError';
import { defaultsSelectValue, fieldDefsShowModelSelect, piRuntimeModelDefaultLabel, type DefaultFieldDef, type DefaultsKey } from './projects';

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
  // not on whether `runtimeModel` happens to still be saved, which used to
  // leave this row standing even after the default account moved off Pi.
  const piModelLabel = fieldDefsShowModelSelect(fieldDefs) ? null : piRuntimeModelDefaultLabel(defaults);

  return (
    <div className={disabled ? 'pj-group is-disabled' : 'pj-group'}>
      <span className="pj-group-label">SESSION DEFAULTS</span>
      <ModelCatalogStatus state={catalogState} />
      {/* pi-models-metrics FR-4: this form's model/effort selects are keyed to
          a legacy modelId and cannot represent a Pi provider/model pair — the
          saved default shows read-only here instead of a select nobody can
          use, and simply never appears in the patch this section sends, so it
          keeps round-tripping on every other field's save. */}
      {piModelLabel && (
        <div className="pj-row">
          <span className="pj-row-label">model (pi)</span>
          {/* pr-142 §C1: the run chip never writes project defaults — a
              session's own "Set as project default" (settings sheet) does. */}
          <span className="pj-input" title={`set from a session's "Set as project default" — this editor cannot change it yet`}>
            {piModelLabel}
          </span>
        </div>
      )}
      {fieldDefs.map((field) => {
        const value = defaultsSelectValue(defaults, field.key);
        // §7 case 22: a stored default the catalog no longer offers has no
        // matching <option>, so the select would silently render `inherit`
        // and drop the value the moment it is touched. Surface it instead —
        // the new-session modal already says so via `staleModelId`.
        const stale = value !== '' && !field.options.some((o) => o.value === value);
        return (
          <div key={field.key} className="pj-row">
            <span className="pj-row-label">{field.label}</span>
            <select
              value={value}
              onChange={(e) => onCommit(field.key, e.target.value)}
              className="pj-input"
              style={{ color: value === '' ? 'var(--text-faint)' : stale ? 'var(--error)' : 'var(--text)' }}
            >
              {stale && <option disabled value={value}>{`${value} · Not in the current catalogue`}</option>}
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {error !== null && <InlineError>{error}</InlineError>}
    </div>
  );
}

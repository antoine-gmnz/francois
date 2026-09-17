import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import type { ModelCatalogState } from '../../lib/hooks/useModelCatalog';
// projects — ProjectsModal's SESSION DEFAULTS group: five uniform selects,
// disabled while the root is missing (FR-38). Split out of ProjectsModal's
// `{selected && (...)}` block per REFACTOR.md §6c.

import type { ProjectDefaults } from '../../../contract/common';
import { InlineError } from './InlineError';
import { defaultsSelectValue, type DefaultFieldDef, type DefaultsKey } from './projects';

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
  return (
    <div className={disabled ? 'pj-group is-disabled' : 'pj-group'}>
      <span className="pj-group-label">SESSION DEFAULTS</span>
      <ModelCatalogStatus state={catalogState} />
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

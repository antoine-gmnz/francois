// Redesign turn 8b — the Accounts modal's new left rail: every catalog
// provider, split CONNECTED over AVAILABLE (`splitRail`, providers.ts). A row
// is a plain `<button>` rather than a div+onClick, so the rail stays reachable
// by keyboard (the modal's own arrow-key model still owns the credential list
// inside the detail pane — this is a second, independent tab stop).
//
// The state glyph never carries the only signal: `aria-label`/`title` name the
// state in words (§Accessibility) — colour alone is not a cue.

import { StateIcon } from '../../ui/StateIcon';
import type { StateKind } from '../../ui/state-kind';
import { ProviderTile } from './ProviderTile';
import { splitRail, type ProviderGroup, type ProviderId, type ProviderStatus } from './providers';
import './accounts-page.css';

export interface ProviderRailProps {
  groups: ProviderGroup[];
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
}

const STATE: Record<Exclude<ProviderStatus, 'none'>, { kind: StateKind; label: string }> = {
  attention: { kind: 'failed', label: 'needs attention' },
  active: { kind: 'done', label: 'active' },
  idle: { kind: 'idle', label: 'idle' },
};

/** The row's state glyph (Figma "State"), named in words for AT and the tooltip. */
function ProviderState({ status }: { status: ProviderStatus }): JSX.Element | null {
  if (status === 'none') return null;
  const { kind, label } = STATE[status];
  return <StateIcon kind={kind} size={12} title={label} className="acc-rail-state" />;
}

function RailRow({
  group,
  selected,
  onSelect,
}: {
  group: ProviderGroup;
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
}): JSX.Element {
  const active = group.spec.id === selected;
  const classNames = ['acc-rail-row'];
  if (active) classNames.push('acc-rail-row--active');
  if (!group.connected) classNames.push('acc-rail-row--available');

  return (
    <button
      type="button"
      className={classNames.join(' ')}
      aria-current={active ? 'true' : undefined}
      title={group.spec.name}
      onClick={() => onSelect(group.spec.id)}
    >
      <ProviderTile spec={group.spec} />
      <div className="acc-rail-text">
        <span className="truncate acc-rail-name">{group.spec.name}</span>
        <span className="truncate acc-rail-meta">{group.meta}</span>
      </div>
      <ProviderState status={group.status} />
    </button>
  );
}

export function ProviderRail({ groups, selected, onSelect }: ProviderRailProps): JSX.Element {
  const { connected, available } = splitRail(groups);

  return (
    <nav className="acc-rail" aria-label="Providers">
      {connected.length > 0 && (
        <div className="acc-rail-section">
          <div className="acc-rail-heading">Connected</div>
          {connected.map((g) => (
            <RailRow key={g.spec.id} group={g} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
      {available.length > 0 && (
        <div className="acc-rail-section">
          <div className="acc-rail-heading">Available</div>
          {available.map((g) => (
            <RailRow key={g.spec.id} group={g} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </nav>
  );
}

// Redesign turn 8b — the Accounts modal's new left rail: every catalog
// provider, split CONNECTED over AVAILABLE (`splitRail`, providers.ts). A row
// is a plain `<button>` rather than a div+onClick, so the rail stays reachable
// by keyboard (the modal's own arrow-key model still owns the credential list
// inside the detail pane — this is a second, independent tab stop).
//
// The status dot never carries the only signal: `aria-label`/`title` name the
// state in words (§Accessibility), because colour alone is exactly the kind of
// cue the design system v2 do/don't rules forbid.

import { ProviderTile } from './ProviderTile';
import { splitRail, type ProviderGroup, type ProviderId, type ProviderStatus } from './providers';
import './accounts.css';

export interface ProviderRailProps {
  groups: ProviderGroup[];
  selected: ProviderId;
  onSelect: (id: ProviderId) => void;
}

const DOT_LABEL: Record<Exclude<ProviderStatus, 'none'>, string> = {
  attention: 'needs attention',
  active: 'active',
  idle: 'idle',
};

function StatusDot({ status }: { status: ProviderStatus }): JSX.Element | null {
  if (status === 'none') return null;
  const label = DOT_LABEL[status];
  return <span className={`acc-dot acc-dot--${status}`} role="img" aria-label={label} title={label} />;
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
      <StatusDot status={group.status} />
    </button>
  );
}

export function ProviderRail({ groups, selected, onSelect }: ProviderRailProps): JSX.Element {
  const { connected, available } = splitRail(groups);

  return (
    <div className="scz acc-rail">
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
    </div>
  );
}

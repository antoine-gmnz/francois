// cloud-sessions §8 — the adopt modal's session list: skeleton rows while it
// loads, one calm line when it degraded, otherwise the rows themselves.
//
// Two rules from the brief run through this file:
//  - The list NEVER gates the paste field. Its loading, degraded and empty
//    states are all quiet; none of them is an error card.
//  - Nothing is synthesized. A row shows the fields the API actually returned
//    (title → the short id when absent; repo/branch/updated-at hidden when
//    absent), because an invented branch is worse than a missing one.

import type { CloudSession } from '../../../contract/cloud-sessions';
import { ListRow } from '../../ui/ListRow';
import { cloudListRender, cloudRowMeta, cloudRowTitle, type CloudListState } from './cloud-sessions';
import './cloud-sessions.css';

export interface CloudSessionListProps {
  list: CloudListState;
  /** The ref currently in the paste field — a row is selected when it matches. */
  selectedId: string | null;
  /** Keyboard cursor (↑/↓), or -1 when the list has not been walked yet. */
  cursor: number;
  onPick: (session: CloudSession) => void;
}

export function CloudSessionList({ list, selectedId, cursor, onPick }: CloudSessionListProps): JSX.Element {
  const rendered = cloudListRender(list);

  if (rendered.kind === 'loading') {
    return (
      <div className="cloud-list cloud-list--skeleton" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="cloud-list__skeleton-row">
            <span className="cloud-list__skeleton-bar cloud-list__skeleton-bar--title" />
            <span className="cloud-list__skeleton-bar cloud-list__skeleton-bar--meta" />
          </div>
        ))}
      </div>
    );
  }

  // FR-17: the common state for anyone offline. One line, --text-disabled, no
  // icon, no error tone — and the paste field right above it still works. An
  // account with no cloud sessions gets its own line: same calm treatment, but
  // it must not claim a fetch failed when the fetch succeeded.
  if (rendered.kind === 'note') return <div className="cloud-list__degraded">{rendered.line}</div>;

  // The one list failure a user can act on (FR-1 auth), shown where the list
  // would be rather than adrift at the bottom of the modal — and never dressed
  // up as "this account has none", which would be a claim we cannot make.
  if (rendered.kind === 'error') {
    return (
      <div className="cloud-list__error" role="status">
        {rendered.line}
      </div>
    );
  }

  return (
    <div className="cloud-list scz" role="listbox" aria-label="Your cloud sessions">
      {list.sessions.map((session, i) => (
        <CloudSessionRow
          key={session.id}
          session={session}
          selected={session.id === selectedId}
          hovered={i === cursor}
          onPick={() => onPick(session)}
        />
      ))}
    </div>
  );
}

function CloudSessionRow({
  session,
  selected,
  hovered,
  onPick,
}: {
  session: CloudSession;
  selected: boolean;
  hovered: boolean;
  onPick: () => void;
}): JSX.Element {
  const meta = cloudRowMeta(session);
  return (
    <ListRow
      className="cloud-row"
      selected={selected}
      hovered={hovered}
      role="option"
      aria-selected={selected}
      title={session.id}
      onClick={onPick}
    >
      <span className="cloud-row__title truncate">{cloudRowTitle(session)}</span>
      {meta.length > 0 && (
        <span className="cloud-row__meta truncate">
          {meta.map((part, i) => (
            <span key={i} className="cloud-row__meta-part">
              {part}
            </span>
          ))}
        </span>
      )}
    </ListRow>
  );
}

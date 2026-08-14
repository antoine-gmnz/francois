// FR-36: the `table` primitive — declared typed columns with a header row, a
// per-kind cell treatment, an optional selected state (the row drives the
// log-tail below it), and FR-31/FR-32's `Load more` row.
//
// Every string here is provider-derived and therefore hostile by default: it
// arrives already sanitized and truncated to 512 chars by the core (FR-51), and
// it is rendered as TEXT — no `dangerouslySetInnerHTML`, no markdown, no href
// (FR-50/FR-52). The only defence this file adds is layout: every cell truncates
// rather than widening, so 512 characters of punctuation cannot produce a
// horizontal scrollbar on the whole pane.

import type { ColumnDef, TableRow } from '../../../contract/extensions';
import { ListRow } from '../../ui/ListRow';
import {
  LOAD_MORE_COPY,
  PAGE_CAP_NOTICE,
  canLoadMore,
  cellClassName,
  cellText,
  sanitizeForDisplay,
  toneClassName,
  truncatePathLeft,
  type TableCursor,
} from './extensions';

const PATH_MAX_CHARS = 44;

export interface ExtTableProps {
  columns: ColumnDef[];
  cursor: TableCursor;
  paginated: boolean;
  loading: boolean;
  selectable: boolean;
  selectedRowId: string | null;
  onSelectRow: (row: TableRow) => void;
  onLoadMore: () => void;
}

export default function ExtTable({
  columns,
  cursor,
  paginated,
  loading,
  selectable,
  selectedRowId,
  onSelectRow,
  onLoadMore,
}: ExtTableProps) {
  const template = columns.map((c) => `${c.weight ?? 1}fr`).join(' ');
  return (
    <div className="ext-table">
      {/* The column template is computed from the panel's declared weights —
          runtime data, the one case the CSS contract allows inline. */}
      <div className="ext-table__head" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <span key={c.key} className={`ext-table__th ext-table__th--${c.kind}`} title={sanitizeForDisplay(c.label)}>
            {sanitizeForDisplay(c.label)}
          </span>
        ))}
      </div>
      {cursor.rows.map((row) => (
        <ListRow
          key={row.id}
          selected={selectable && row.id === selectedRowId}
          className="ext-table__row"
          style={{ gridTemplateColumns: template }}
          onClick={selectable ? () => onSelectRow(row) : undefined}
          // Accessibility: selection drives what the section below streams, so
          // it is announced, not just coloured (design brief §Notes).
          role={selectable ? 'button' : undefined}
          aria-pressed={selectable ? row.id === selectedRowId : undefined}
        >
          {selectable && <span className="ext-table__marker">{row.id === selectedRowId ? '▸' : ''}</span>}
          {columns.map((c) => (
            <Cell key={c.key} column={c} row={row} />
          ))}
        </ListRow>
      ))}
      {paginated && cursor.capped && <div className="ext-table__more ext-table__more--capped">{PAGE_CAP_NOTICE}</div>}
      {paginated && canLoadMore(cursor) && (
        <div className="ext-table__more" onClick={loading ? undefined : onLoadMore}>
          {loading ? '…' : LOAD_MORE_COPY}
        </div>
      )}
    </div>
  );
}

function Cell({ column, row }: { column: ColumnDef; row: TableRow }) {
  const raw = row.cells[column.key];
  const text = cellText(column.kind, raw);
  if (column.kind === 'status') {
    // A status cell is toned by the ROW's tone (FR-36) — never by the accent.
    return text === '' ? (
      <span className={cellClassName(column.kind)} />
    ) : (
      <span className={cellClassName(column.kind)}>
        <span className={toneClassName(row.tone)}>{text}</span>
      </span>
    );
  }
  if (column.kind === 'path') {
    return (
      <span className={cellClassName(column.kind)} title={text}>
        {truncatePathLeft(text, PATH_MAX_CHARS)}
      </span>
    );
  }
  return (
    <span className={cellClassName(column.kind)} title={text}>
      {text}
    </span>
  );
}

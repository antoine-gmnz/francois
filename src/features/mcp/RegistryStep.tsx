// AttachOverlay's first step: pick a registry entry or "custom…".

import type { AppError } from '../../../contract/common';
import type { McpRegistryEntry } from '../../../contract/mcp-panel';

export function RegistryStep({
  rows,
  regError,
  selIndex,
  onHover,
  onSelect,
}: {
  rows: (McpRegistryEntry | 'custom')[];
  regError: AppError | null;
  selIndex: number;
  onHover: (i: number) => void;
  onSelect: (row: McpRegistryEntry | 'custom') => void;
}) {
  return (
    <div className="mcp-registry-list">
      {regError && <div className="mcp-registry-error">{regError.message} — custom still available</div>}
      {rows.map((row, i) => (
        <RegistryRow key={row === 'custom' ? 'custom' : row.name} row={row} selected={i === selIndex} onMouseEnter={() => onHover(i)} onClick={() => onSelect(row)} />
      ))}
    </div>
  );
}

function RegistryRow({
  row,
  selected,
  onMouseEnter,
  onClick,
}: {
  row: McpRegistryEntry | 'custom';
  selected: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const isCustom = row === 'custom';
  return (
    <div onMouseEnter={onMouseEnter} onClick={onClick} className={selected ? 'mcp-registry-row mcp-registry-row--selected' : 'mcp-registry-row'}>
      <span className={selected ? 'mcp-registry-glyph mcp-registry-glyph--selected' : 'mcp-registry-glyph'}>{isCustom ? '+' : '⊞'}</span>
      <span className={selected ? 'mcp-registry-name mcp-registry-name--selected' : 'mcp-registry-name'}>{isCustom ? 'custom…' : row.name}</span>
      <span className="mcp-registry-desc">{isCustom ? 'define manually' : row.description}</span>
    </div>
  );
}

// Pane title + count + focus-accent border: the `PANE_NAME · [n]` header row
// repeated byte-for-byte in AgentsPanel and SkillsPanel (and, less exactly,
// in Sidebar/McpPanel — see the frontend handoff for why those two are not
// claimed by this component).
//
// The focus accent is a boolean state, like ListRow's selected/hovered or
// Chip's selected — so it is a modifier class (`panel-header--focused`),
// not an inline color. Nothing else here is genuinely dynamic: title and
// count are content, not style.
//
// collapse-right-column FR-16: `collapsed`/`onToggleCollapse` are additive and
// optional so existing call sites compile unchanged. When `onToggleCollapse`
// is present the header row becomes a click target (leading chevron, pointer
// cursor, hover treatment); FR-8's stopPropagation lives here so the click
// never also fires the card's own focus handler.

export interface PanelHeaderProps {
  /** Rendered verbatim — already the correct copy for the pane (e.g. 'AGENTS'). */
  title: string;
  count: number;
  /** The pane hotkey, rendered as `· [paneKey]` (e.g. 3 → `· [3]`). */
  paneKey: string | number;
  focused: boolean;
  /** Renders ▸ instead of ▾ when true. */
  collapsed?: boolean;
  /** Present ⇒ header row is clickable (cursor: pointer, chevron, hover). */
  onToggleCollapse?: () => void;
}

export function panelHeaderClassName(focused: boolean, clickable = false, collapsed = false): string {
  const parts = ['panel-header'];
  if (focused) parts.push('panel-header--focused');
  if (clickable) parts.push('panel-header--clickable');
  if (collapsed) parts.push('panel-header--collapsed');
  return parts.join(' ');
}

export function PanelHeader({ title, count, paneKey, focused, collapsed, onToggleCollapse }: PanelHeaderProps): JSX.Element {
  const clickable = onToggleCollapse !== undefined;
  return (
    <div
      className={panelHeaderClassName(focused, clickable, collapsed)}
      onClick={
        onToggleCollapse
          ? (e: React.MouseEvent) => {
              e.stopPropagation();
              onToggleCollapse();
            }
          : undefined
      }
      title={clickable ? (collapsed ? 'expand' : 'collapse') : undefined}
    >
      <span>
        {clickable && <span className="panel-header-chevron">{collapsed ? '▸' : '▾'}</span>}
        {title}
      </span>
      <span>
        {count} · [{paneKey}]
      </span>
    </div>
  );
}

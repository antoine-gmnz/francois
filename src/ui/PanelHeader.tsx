// Pane title + count + focus-accent border: the `PANE_NAME · [n]` header row
// repeated byte-for-byte in AgentsPanel and SkillsPanel (and, less exactly,
// in Sidebar/McpPanel — see the frontend handoff for why those two are not
// claimed by this component).
//
// The focus accent is a boolean state, like ListRow's selected/hovered or
// Chip's selected — so it is a modifier class (`panel-header--focused`),
// not an inline color. Nothing else here is genuinely dynamic: title and
// count are content, not style.

export interface PanelHeaderProps {
  /** Rendered verbatim — already the correct copy for the pane (e.g. 'AGENTS'). */
  title: string;
  count: number;
  /** The pane hotkey, rendered as `· [paneKey]` (e.g. 3 → `· [3]`). */
  paneKey: string | number;
  focused: boolean;
}

export function panelHeaderClassName(focused: boolean): string {
  return focused ? 'panel-header panel-header--focused' : 'panel-header';
}

export function PanelHeader({ title, count, paneKey, focused }: PanelHeaderProps): JSX.Element {
  return (
    <div className={panelHeaderClassName(focused)}>
      <span>{title}</span>
      <span>
        {count} · [{paneKey}]
      </span>
    </div>
  );
}

// Footer key/label hint strip. Replaces AgentsPanel's NewAgentModal footer
// and SkillsPanel's Footer component — the latter had already generalized to
// a `[string, string][]` tuple list, which this keeps as a named-field shape.

export interface HintBarItem {
  /** The kbd glyph or text, e.g. '⏎', 'esc', '↑↓'. */
  key: string;
  label: string;
}

export interface HintBarProps {
  items: HintBarItem[];
}

export function HintBar({ items }: HintBarProps): JSX.Element {
  return (
    <div className="hint-bar">
      {items.map((item) => (
        <span key={item.label}>
          <span className="hint-bar__key">{item.key}</span> {item.label}
        </span>
      ))}
    </div>
  );
}

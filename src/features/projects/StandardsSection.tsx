// projects — ProjectsModal's STANDARDS group: notes + the rule list, written
// into <root>/CLAUDE.md's managed block. Disabled until the on-disk read
// lands (an interactive editor rendering from an empty fallback invites a
// commit that would overwrite the real block). Split out of ProjectsModal's
// `{selected && (...)}` block per REFACTOR.md §6c.

import { useState } from 'react';
import { MAX_RULES } from '../../../contract/projects';
import { Action } from './Action';
import { InlineError } from './InlineError';
import { STANDARDS_FOOTER_NOTE, addRule, dropRule, moveRule, replaceRule, standardsFooterPath } from './projects';

export function StandardsSection({
  root,
  notes,
  onNotesChange,
  onNotesCommit,
  rules,
  editIndex,
  setEditIndex,
  editDraft,
  setEditDraft,
  newRule,
  setNewRule,
  onCommitRules,
  error,
  onOverQuota,
  disabled,
}: {
  root: string;
  notes: string;
  onNotesChange: (value: string) => void;
  onNotesCommit: () => void;
  rules: string[];
  editIndex: number;
  setEditIndex: (i: number) => void;
  editDraft: string;
  setEditDraft: (value: string) => void;
  newRule: string;
  setNewRule: (value: string) => void;
  onCommitRules: (nextRules: string[]) => void;
  error: string | null;
  onOverQuota: (message: string) => void;
  disabled: boolean;
}) {
  return (
    <div className={disabled ? 'pj-group is-disabled' : 'pj-group'}>
      <span className="pj-group-label">STANDARDS</span>
      <textarea
        value={notes}
        placeholder="notes for every session in this project…"
        onChange={(e) => onNotesChange(e.target.value)}
        onBlur={onNotesCommit}
        className="pj-input pj-textarea"
      />

      <div className="pj-rules">
        {rules.map((text, i) => (
          <RuleRow
            key={`${i}-${text}`}
            text={text}
            editing={editIndex === i}
            draft={editDraft}
            onDraft={setEditDraft}
            onEdit={() => {
              setEditIndex(i);
              setEditDraft(text);
            }}
            onCommit={() => {
              setEditIndex(-1);
              onCommitRules(replaceRule(rules, i, editDraft));
            }}
            onUp={() => onCommitRules(moveRule(rules, i, -1))}
            onDown={() => onCommitRules(moveRule(rules, i, 1))}
            onDrop={() => onCommitRules(dropRule(rules, i))}
          />
        ))}
        {rules.length === 0 && <span className="pj-rules-empty">no rules yet</span>}
        <input
          value={newRule}
          placeholder="add a rule…"
          onChange={(e) => setNewRule(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const next = addRule(rules, newRule);
            // addRule returns the SAME array when it refused (blank, or the
            // MAX_RULES cap). Clearing the input unconditionally silently ate
            // the text the user had typed, with no message.
            if (next === rules) {
              if (newRule.trim() !== '') onOverQuota(`at most ${MAX_RULES} rules`);
              return;
            }
            setNewRule('');
            onCommitRules(next);
          }}
          className="pj-input pj-rule-input"
        />
      </div>

      {error !== null && <InlineError>{error}</InlineError>}

      <div className="pj-footer-note">
        <span>{standardsFooterPath(root)}</span>
        <span>{STANDARDS_FOOTER_NOTE}</span>
      </div>
    </div>
  );
}

function RuleRow({
  text,
  editing,
  draft,
  onDraft,
  onEdit,
  onCommit,
  onUp,
  onDown,
  onDrop,
}: {
  text: string;
  editing: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onEdit: () => void;
  onCommit: () => void;
  onUp: () => void;
  onDown: () => void;
  onDrop: () => void;
}) {
  // §8 C: the reorder/delete cluster appears on hover. Kept mounted (opacity, not
  // conditional render) so the row never reflows under the cursor, and forced
  // visible while the row is being edited so the controls do not vanish mid-edit.
  const [hover, setHover] = useState(false);
  const showActions = hover || editing;
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="pj-rule-row">
      <span className="pj-rule-dash">-</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="pj-rule-edit-input"
        />
      ) : (
        <span onClick={onEdit} className="pj-rule-text">
          {text}
        </span>
      )}
      <span
        className="pj-rule-actions"
        style={{ opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'auto' : 'none' }}
      >
        <Action color="var(--text-faint)" hoverColor="var(--accent)" onClick={onUp} title="move rule up" size={10}>
          ↑
        </Action>
        <Action color="var(--text-faint)" hoverColor="var(--accent)" onClick={onDown} title="move rule down" size={10}>
          ↓
        </Action>
        <Action color="var(--text-faint)" hoverColor="var(--error)" onClick={onDrop} title="remove rule" size={10}>
          ×
        </Action>
      </span>
    </div>
  );
}

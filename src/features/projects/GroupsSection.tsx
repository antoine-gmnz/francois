// project-groups FR-19/FR-20: the Projects modal's left-column GROUPS block —
// each group as a row with inline rename, a typed-confirm-pattern remove (the
// same expand-in-place RemoveControl projects use), and "+ New group" styled
// after NewProjectControl. Group rows are not selectable into the config pane
// (FR-19) — a group has no config of its own.

import { useState } from 'react';
import type { ProjectGroup } from '../../../contract/projects';
import { RemoveControl } from '../../ui/RemoveControl';
import { InlineError } from './InlineError';
import { removeGroupConfirmText } from './projects';

export function GroupsSection({
  groups,
  onAdd,
  onRename,
  onRemove,
  error,
  newGroupDraft,
  setNewGroupDraft,
}: {
  groups: ProjectGroup[];
  onAdd: (name: string) => void;
  onRename: (groupId: string, name: string) => void;
  onRemove: (groupId: string) => void;
  error: string | null;
  /** non-null while the inline "+ New group" field is open; '' just after opening. */
  newGroupDraft: string | null;
  setNewGroupDraft: (v: string | null) => void;
}) {
  return (
    <div className="pj-groups">
      <span className="pj-group-label pj-groups-label">GROUPS</span>
      {groups.map((g) => (
        <GroupRow key={g.id} group={g} onRename={(name) => onRename(g.id, name)} onRemove={() => onRemove(g.id)} />
      ))}
      {newGroupDraft !== null ? (
        <input
          autoFocus
          value={newGroupDraft}
          placeholder="group name…"
          onChange={(e) => setNewGroupDraft(e.target.value)}
          onBlur={() => {
            if (newGroupDraft.trim() === '') setNewGroupDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const trimmed = newGroupDraft.trim();
              if (trimmed === '') {
                setNewGroupDraft(null);
                return;
              }
              onAdd(trimmed);
            }
            if (e.key === 'Escape') setNewGroupDraft(null);
          }}
          className="pj-input pj-new-group-input"
        />
      ) : (
        <div onClick={() => setNewGroupDraft('')} className="pj-new-group">
          + New group
        </div>
      )}
      {error !== null && <InlineError>{error}</InlineError>}
    </div>
  );
}

function GroupRow({
  group,
  onRename,
  onRemove,
}: {
  group: ProjectGroup;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="pj-group-row">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const trimmed = draft.trim();
            // §7 case 5: a blank/unchanged edit is a no-op; a rejected commit
            // (INVALID_INPUT) reverts to the persisted name once the next
            // reload() lands, since this row stops editing and renders
            // `group.name` directly.
            if (trimmed !== '' && trimmed !== group.name) onRename(trimmed);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(group.name);
              setEditing(false);
            }
          }}
          className="pj-group-edit-input"
        />
      ) : (
        <span
          className="truncate pj-group-name"
          onClick={() => {
            setDraft(group.name);
            setEditing(true);
          }}
        >
          {group.name}
        </span>
      )}
      <span className="app-flex-spacer" />
      <RemoveControl
        confirmText={removeGroupConfirmText(group.name)}
        confirming={confirming}
        onConfirm={() => setConfirming(true)}
        onCancel={() => setConfirming(false)}
        onRemove={() => {
          setConfirming(false);
          onRemove();
        }}
      />
    </div>
  );
}

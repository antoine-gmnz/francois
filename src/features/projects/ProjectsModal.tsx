// projects — the Projects modal (FR-31..FR-38). Two columns: the registry on the
// left, one project's config on the right (Identity / Session defaults /
// Standards).
//
// It never trusts cached state (FR-32): project_list on open and after every
// registry mutation, project_get_standards on every selection change, and
// project_set_standards repaints from the FRESH RE-READ it resolves (FR-16),
// never from what was typed. There is no Save button (FR-35) — each commit fires
// its command; a failure shows inline and re-reads so the form returns to
// on-disk truth. Nothing here ever throws (safeCall).
//
// The registry reads/effects live in `useProjectRegistry`, the write path in
// `useProjectMutations`, and the right-hand config form in `IdentitySection` /
// `DefaultsSection` / `StandardsSection` / `RemoveControl` (REFACTOR.md §6c).

import { useRef, useState } from 'react';
import type { ProjectMeta } from '../../../contract/projects';
import { IS_WINDOWS } from '../../lib/platform';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { ListRow } from '../../ui/ListRow';
import { DefaultsSection } from './DefaultsSection';
import { IdentitySection } from './IdentitySection';
import { RemoveControl } from './RemoveControl';
import { StandardsSection } from './StandardsSection';
import { abbreviateRoot, defaultFieldDefs, projectCountLabel } from './projects';
import { useProjectMutations } from './useProjectMutations';
import { useProjectRegistry } from './useProjectRegistry';
import './projects.css';

export default function ProjectsModal({ home, onClose }: { home: string; onClose: () => void }) {
  const registry = useProjectRegistry();
  const mutations = useProjectMutations({
    projects: registry.projects,
    selectedId: registry.selectedId,
    selected: registry.selected,
    draftOwner: registry.draftOwner,
    nameDraft: registry.nameDraft,
    rootDraft: registry.rootDraft,
    standards: registry.standards,
    notes: registry.notes,
    rules: registry.rules,
    alive: registry.alive,
    reload: registry.reload,
    syncDrafts: registry.syncDrafts,
    setStandards: registry.setStandards,
    setNotes: registry.setNotes,
    setError: registry.setError,
    setRemoveConfirm: registry.setRemoveConfirm,
  });
  const dismissRef = useRef<HTMLDivElement>(null);

  // FR-37: Escape and a backdrop click close. Escape inside an inline rule edit
  // reverts that row only, without closing the modal (§8 Interactions).
  useDismiss(dismissRef, {
    onEscape: () => {
      if (registry.editIndex >= 0) registry.setEditIndex(-1);
      else onClose();
    },
  });

  const { selected, rootMissing } = registry;
  const fieldDefs = defaultFieldDefs(registry.models, selected?.defaults ?? {}, IS_WINDOWS);

  return (
    <div onClick={onClose} className="pj-backdrop">
      <div onClick={(e) => e.stopPropagation()} className="pj-panel">
        {/* header */}
        <div className="pj-header">
          <span className="pj-title">PROJECTS</span>
          <span className="pj-count">{projectCountLabel(registry.projects.length)}</span>
        </div>

        <div className="pj-body">
          {/* left: the registry (FR-33) */}
          <div className="pj-list">
            <div className="scz pj-list-scroll">
              {registry.projects.length === 0 ? (
                <div className="pj-empty">no projects yet</div>
              ) : (
                registry.projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    home={home}
                    selected={p.id === registry.selectedId}
                    onClick={() => registry.setSelectedId(p.id)}
                  />
                ))
              )}
            </div>
            {registry.errors.list !== null && <div className="pj-list-error">{registry.errors.list}</div>}
            <NewProjectControl onClick={() => void mutations.addProject()} />
          </div>

          {/* right: the config form (FR-34) */}
          {selected && (
            <div
              className="scz pj-config"
              style={mutations.busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
            >
              {/* IDENTITY — stays editable even when the root is gone (FR-38) */}
              <IdentitySection
                nameDraft={registry.nameDraft}
                onNameChange={registry.setNameDraft}
                onNameCommit={mutations.commitName}
                rootDraft={registry.rootDraft}
                onRootChange={registry.setRootDraft}
                onRootCommit={mutations.commitRoot}
                error={registry.errors.identity}
                rootMissing={rootMissing}
              />

              {/* SESSION DEFAULTS — disabled while the root is missing (FR-38) */}
              <DefaultsSection
                fieldDefs={fieldDefs}
                defaults={selected.defaults}
                onCommit={mutations.commitDefault}
                error={registry.errors.defaults}
                disabled={rootMissing}
              />

              {/* STANDARDS — written into <root>/CLAUDE.md's managed block.
                  Disabled until the on-disk read lands (`standards === null`): an
                  interactive editor rendering from an empty fallback invites a commit
                  that would overwrite the real block. */}
              <StandardsSection
                root={selected.root}
                notes={registry.notes}
                onNotesChange={registry.setNotes}
                onNotesCommit={mutations.commitNotes}
                rules={registry.rules}
                editIndex={registry.editIndex}
                setEditIndex={registry.setEditIndex}
                editDraft={registry.editDraft}
                setEditDraft={registry.setEditDraft}
                newRule={registry.newRule}
                setNewRule={registry.setNewRule}
                onCommitRules={mutations.commitRules}
                error={registry.errors.standards}
                onOverQuota={(message) => registry.setError('standards', message)}
                disabled={rootMissing || registry.standards === null}
              />

              {/* REMOVE (FR-36) */}
              <RemoveControl
                name={selected.name}
                confirming={registry.removeConfirm}
                onConfirm={() => registry.setRemoveConfirm(true)}
                onCancel={() => registry.setRemoveConfirm(false)}
                onRemove={() => void mutations.doRemove()}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  home,
  selected,
  onClick,
}: {
  project: ProjectMeta;
  home: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <ListRow
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      selected={selected}
      hovered={hover}
      className="pj-project-row"
      style={{ borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent' }}
    >
      <div className="pj-project-row-top">
        <span className={`truncate pj-project-name${selected ? ' pj-project-name--selected' : ''}`}>
          {project.name}
        </span>
        {!project.rootExists && <span className="pj-missing-tag">missing</span>}
      </div>
      <span className="truncate pj-project-root">{abbreviateRoot(project.root, home)}</span>
    </ListRow>
  );
}

function NewProjectControl({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pj-new-project"
      style={{ color: hover ? 'var(--accent)' : 'var(--text-dim)' }}
    >
      + New project
    </div>
  );
}

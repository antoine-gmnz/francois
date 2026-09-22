// projects — Settings / Project (Figma 22 · 140:7787, light 142:16692): the
// project pages' "General" entry. It replaces the Projects modal's right-hand
// config column; the modal's left list became the Settings nav's project picker
// (SettingsProjectPicker).
//
//   orbit / General
//   orbit                       ← heading, root in mono under it
//   [General | Session defaults | Standards]
//   form …                      ← the selected tab
//   Edits save when you leave a field.
//
// Nothing here has a Save button (FR-35): each field commits on blur/change and
// re-reads (useProjectMutations). Esc inside an inline rule edit reverts the row
// only — it is consumed before the Settings view's own Esc-to-close sees it.

import { useRef, useState } from 'react';
import { IS_WINDOWS } from '../../lib/platform';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { SettingsCard, SettingsHeader } from '../../ui/Settings';
import { Tab, TabGroup } from '../../ui/Tab';
import { DefaultsSection } from './DefaultsSection';
import { GroupsSection } from './GroupsSection';
import { IdentitySection } from './IdentitySection';
import { StandardsSection } from './StandardsSection';
import { abbreviateRoot, defaultFieldDefs, removeConfirmText } from './projects';
import type { ProjectSettings } from './useProjectSettings';
import './project-settings.css';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'defaults', label: 'Session defaults' },
  { id: 'standards', label: 'Standards' },
] as const;
type ProjectTab = (typeof TABS)[number]['id'];

export default function ProjectSettingsPage({ settings, home }: { settings: ProjectSettings; home: string }) {
  const { registry, mutations } = settings;
  const [tab, setTab] = useState<ProjectTab>('general');
  const accounts = useStore((s) => s.accounts);
  const profiles = useStore((s) => s.profiles);
  const dismissRef = useRef<HTMLDivElement>(null);

  // §8 Interactions: Escape inside an inline rule edit reverts that row only.
  useDismiss(dismissRef, { enabled: registry.editIndex >= 0, onEscape: () => registry.setEditIndex(-1) });

  const { selected, rootMissing } = registry;

  if (!selected) {
    return (
      <div className="pj-page">
        <SettingsHeader
          crumbs={['Project']}
          title="No projects yet"
          lede="A project pairs a folder with the defaults and standards every session in it starts from."
          action={
            <Button variant="primary" disabled={mutations.busy} onClick={() => void mutations.addProject()}>
              Add project
            </Button>
          }
        />
        {registry.errors.list !== null && <div className="pj-inline-error">{registry.errors.list}</div>}
      </div>
    );
  }

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? '';
  const fieldDefs = defaultFieldDefs(registry.models, selected.defaults ?? {}, IS_WINDOWS, accounts, profiles);

  return (
    <div ref={dismissRef} className={mutations.busy ? 'pj-page pj-page--busy' : 'pj-page'}>
      <SettingsHeader
        crumbs={[selected.name, tabLabel]}
        title={selected.name}
        lede={abbreviateRoot(selected.root, home)}
        ledeMono
      />

      <TabGroup label="Project settings">
        {TABS.map((t) => (
          <Tab key={t.id} selected={tab === t.id} onSelect={() => setTab(t.id)}>
            {t.label}
          </Tab>
        ))}
      </TabGroup>

      {registry.errors.list !== null && <div className="pj-inline-error">{registry.errors.list}</div>}

      {tab === 'general' && (
        <div className="pj-form">
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
            groups={registry.groups}
            groupId={selected.groupId ?? ''}
            onGroupChange={(groupId) => void mutations.assignGroup(groupId)}
          />

          {/* project-groups FR-19/FR-20: the groups a project can join, managed
              where the Group select is. */}
          <GroupsSection
            groups={registry.groups}
            onAdd={(name) => void mutations.addGroup(name)}
            onRename={(groupId, name) => void mutations.renameGroup(groupId, name)}
            onRemove={(groupId) => void mutations.removeGroup(groupId)}
            error={registry.groupError}
            newGroupDraft={registry.newGroupDraft}
            setNewGroupDraft={registry.setNewGroupDraft}
          />

          {/* REMOVE (FR-36) — confirm in place, never on the first click. */}
          <SettingsCard
            tone="danger"
            title="Remove project"
            description={
              registry.removeConfirm
                ? removeConfirmText(selected.name)
                : 'Files and existing sessions are kept. You can add it back any time.'
            }
          >
            {registry.removeConfirm ? (
              <div className="pj-confirm-actions">
                <Button variant="ghost" onClick={() => registry.setRemoveConfirm(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => void mutations.doRemove()}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button variant="danger" onClick={() => registry.setRemoveConfirm(true)}>
                Remove…
              </Button>
            )}
          </SettingsCard>
        </div>
      )}

      {/* SESSION DEFAULTS — disabled while the root is missing (FR-38) */}
      {tab === 'defaults' && (
        <DefaultsSection
          catalogState={registry.catalogState}
          fieldDefs={fieldDefs}
          defaults={selected.defaults}
          onCommit={mutations.commitDefault}
          error={registry.errors.defaults}
          disabled={rootMissing}
        />
      )}

      {/* STANDARDS — written into <root>/CLAUDE.md's managed block. Disabled
          until the on-disk read lands (`standards === null`): an editor
          rendering from an empty fallback invites a commit that would
          overwrite the real block. */}
      {tab === 'standards' && (
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
      )}

      <p className="pj-save-note">Edits save when you leave a field.</p>
    </div>
  );
}

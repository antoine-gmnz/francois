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

import { useEffect, useRef, useState } from 'react';
import type { ModelInfo } from '../../../contract/common';
import { MAX_RULES, type ProjectMeta, type ProjectStandards, type StandardsRead } from '../../../contract/projects';
import {
  projectCreate,
  projectGetStandards,
  projectList,
  projectRemove,
  projectSetStandards,
  projectUpdate,
  sessionModels,
  sessionPickDirectory,
} from '../../lib/api';
import { useStore } from '../../lib/store';
import { IS_WINDOWS } from '../../lib/platform';
import {
  ROOT_MISSING_LINE,
  STANDARDS_FOOTER_NOTE,
  abbreviateRoot,
  addRule,
  canCommitIdentity,
  defaultFieldDefs,
  defaultsSelectValue,
  dropRule,
  moveRule,
  nextSelectionAfterRemove,
  patchDefaults,
  projectCountLabel,
  removeConfirmText,
  replaceRule,
  safeCall,
  standardsFooterPath,
  type DefaultsKey,
} from './projects';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  muted: 'var(--text-muted)',
  primary: 'var(--text)',
  bright: 'var(--text-bright)',
  error: 'var(--error)',
};

const EMPTY_READ: StandardsRead = {
  standards: { notes: '', rules: [] },
  fileExists: false,
  blockPresent: false,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--bg-deep)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 11,
  color: C.primary,
  fontFamily: 'inherit',
  outline: 'none',
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  color: C.dim,
};

const rowLabelStyle: React.CSSProperties = {
  width: 120,
  flexShrink: 0,
  fontSize: 10.5,
  color: C.muted,
};

export default function ProjectsModal({ home, onClose }: { home: string; onClose: () => void }) {
  const setStoreProjects = useStore((s) => s.setProjects);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [standards, setStandards] = useState<StandardsRead | null>(null);
  const [notes, setNotes] = useState('');
  const [newRule, setNewRule] = useState('');
  const [editIndex, setEditIndex] = useState(-1);
  const [editDraft, setEditDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [rootDraft, setRootDraft] = useState('');
  // Which project the Identity drafts belong to. Free-text state outlives a
  // selection change, so the commit guard needs to know whose text this is.
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [standardsError, setStandardsError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const syncDrafts = (p: ProjectMeta | undefined) => {
    setNameDraft(p?.name ?? '');
    setRootDraft(p?.root ?? '');
    setDraftOwner(p?.id ?? null);
  };

  // FR-32: the ONE read path — on open and after every registry mutation.
  const reload = async (preferId?: string | null): Promise<void> => {
    const res = await safeCall(projectList());
    if (!alive.current) return;
    if (!res.ok) {
      setListError(res.error.message);
      return;
    }
    setListError(null);
    setProjects(res.data);
    setStoreProjects(res.data); // keeps the switcher (and FR-26's fallback) honest
    const want = preferId !== undefined ? preferId : selectedId;
    const next = want && res.data.some((p) => p.id === want) ? want : (res.data[0]?.id ?? null);
    setSelectedId(next);
    // Drafts are NOT reseeded here. A selection change is handled by the effect
    // below (which also covers the list-row click, that never calls reload()), and
    // a reload with the selection UNCHANGED must leave an in-progress, unblurred
    // name/root edit alone.
  };

  useEffect(() => {
    void reload();
    void safeCall(sessionModels()).then((res) => {
      if (alive.current && res.ok) setModels(res.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reseed the Identity drafts whenever the SELECTION changes, wherever the change
  // came from. A list row sets `selectedId` directly and never goes through
  // reload(), so without this the drafts kept the PREVIOUS project's name/root
  // while `selected` already pointed at the new one — and a blur then fired
  // commitName/commitRoot, which compare the stale draft against the NEW project's
  // values, do not short-circuit, and write one project's identity onto another.
  // Reachable with no typing at all: focus the name field, click another row, click
  // away. Keyed on `selectedId` ALONE — adding `projects` would re-clobber an
  // unblurred edit on every unrelated reload (the case the reload() guard protects).
  useEffect(() => {
    syncDrafts(projects.find((p) => p.id === selectedId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // The selected project's root, derived here (above the standards effect) because
  // that effect keys on it — a root edit must force a re-read (see below).
  const selectedRoot = projects.find((p) => p.id === selectedId)?.root ?? null;

  // FR-32: standards are re-read from disk on every selection change.
  useEffect(() => {
    setRemoveConfirm(false);
    setEditIndex(-1);
    setNewRule('');
    setIdentityError(null);
    setDefaultsError(null);
    setStandardsError(null);
    if (selectedId === null) {
      setStandards(null);
      setNotes('');
      return;
    }
    let current = true;
    setStandards(null);
    // Clear the notes too, not just `standards`. `rules` falls back to [] via
    // `standards?.…` but `notes` is its own state, so the textarea kept rendering
    // the PREVIOUS project's text for the whole fetch (FR-32: never show cached
    // state from another entity, even in a disabled group).
    setNotes('');
    void safeCall(projectGetStandards(selectedId)).then((res) => {
      if (!current || !alive.current) return;
      if (res.ok) {
        setStandards(res.data);
        setNotes(res.data.standards.notes);
      } else {
        setStandards(EMPTY_READ);
        setNotes('');
        setStandardsError(res.error.message); // e.g. PROJECT_ROOT_MISSING (§7 case 3)
      }
    });
    return () => {
      current = false;
    };
    // Keyed on the ROOT as well as the id: editing a project's root keeps the same
    // selectedId, so without this the editor kept showing the OLD root's block while
    // the footer already pointed at the new file — and the next rule edit wrote the
    // old content into the new root's CLAUDE.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedRoot]);

  // FR-37: Escape and a backdrop click close. Escape inside an inline rule edit
  // reverts that row only, without closing the modal (§8 Interactions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (editIndex >= 0) setEditIndex(-1);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editIndex]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const rootMissing = selected !== null && !selected.rootExists;
  const rules = standards?.standards.rules ?? [];

  // ---------- mutations (no Save button — FR-35) ----------

  const runUpdate = async (patch: { name?: string; root?: string; defaults?: ProjectMeta['defaults'] }, group: 'identity' | 'defaults') => {
    if (!selectedId) return;
    setBusy(true);
    const res = await safeCall(projectUpdate({ projectId: selectedId, ...patch }));
    if (!alive.current) return;
    const setError = group === 'identity' ? setIdentityError : setDefaultsError;
    setError(res.ok ? null : res.error.message);
    // FR-8 normalizes a root (trailing separator stripped, `.`/`..` resolved, case
    // folded), and FR-6 trims a name — so the stored value can differ from what was
    // typed. Reseed the drafts from what the core actually saved, or the inputs keep
    // showing the raw text until the user navigates away and back. Identity only:
    // a defaults change must not touch an unblurred edit.
    if (res.ok && group === 'identity') syncDrafts(res.data);
    await reload(selectedId); // success or failure: back to on-disk truth (FR-32/FR-35)
    if (alive.current) setBusy(false);
  };

  // Both guards fail CLOSED when the draft belongs to another project — see
  // canCommitIdentity. Without that, focusing the name field, clicking a different
  // row, then clicking away renamed the NEWLY selected project to the old one's name.
  const commitName = () => {
    if (!canCommitIdentity(draftOwner, selectedId, nameDraft, selected?.name)) return;
    void runUpdate({ name: nameDraft.trim() }, 'identity');
  };

  const commitRoot = () => {
    if (!canCommitIdentity(draftOwner, selectedId, rootDraft, selected?.root)) return;
    void runUpdate({ root: rootDraft.trim() }, 'identity');
  };

  const commitDefault = (key: DefaultsKey, value: string) => {
    if (!selected) return;
    void runUpdate({ defaults: patchDefaults(selected.defaults, key, value) }, 'defaults');
  };

  // FR-35: the whole standards object on every individual change; FR-16: repaint
  // from the response's fresh re-read, never from what was typed.
  const commitStandards = async (next: ProjectStandards) => {
    if (!selectedId) return;
    setBusy(true);
    const res = await safeCall(projectSetStandards(selectedId, next));
    if (!alive.current) return;
    if (res.ok) {
      setStandardsError(null);
      setStandards(res.data);
      setNotes(res.data.standards.notes);
    } else {
      setStandardsError(res.error.message);
      const re = await safeCall(projectGetStandards(selectedId));
      if (alive.current && re.ok) {
        setStandards(re.data);
        setNotes(re.data.standards.notes);
      }
    }
    if (alive.current) setBusy(false);
  };

  const commitRules = (nextRules: string[]) => {
    // NEVER write before the on-disk read has landed. While `standards` is null the
    // editor renders from `rules = []` and `notes = ''`, so a commit in that window
    // would replace the file's real block with whatever single rule was just typed.
    // (commitNotes has always had this guard; commitRules did not.)
    if (!standards) return;
    // A no-op edit (clamped reorder, unchanged inline edit, empty add) must not
    // rewrite CLAUDE.md — §7 case 9 makes every write lossy for hand-written
    // content inside the block.
    if (nextRules.length === rules.length && nextRules.every((r, i) => r === rules[i])) return;
    void commitStandards({ notes, rules: nextRules });
  };

  const commitNotes = () => {
    if (!standards || notes === standards.standards.notes) return;
    void commitStandards({ notes, rules });
  };

  const addProject = async () => {
    // Re-entry guard: `busy` was only set AFTER the pick resolved, so a double-click
    // opened two native directory dialogs, and a create could start while an update
    // round-trip was still in flight.
    if (busy) return;
    setBusy(true);
    const pick = await safeCall(sessionPickDirectory());
    if (!alive.current) return;
    if (!pick.ok || pick.data === null) setBusy(false);
    if (!pick.ok) {
      setListError(pick.error.message);
      return;
    }
    if (pick.data === null) return; // cancelled
    const res = await safeCall(projectCreate({ root: pick.data.path }));
    if (!alive.current) return;
    if (res.ok) {
      setListError(null);
      await reload(res.data.id);
    } else {
      setListError(res.error.message); // e.g. PROJECT_DUPLICATE_ROOT (§7 case 2)
      await reload();
    }
    if (alive.current) setBusy(false);
  };

  const doRemove = async () => {
    if (!selectedId) return;
    const next = nextSelectionAfterRemove(projects, selectedId);
    setBusy(true);
    const res = await safeCall(projectRemove(selectedId));
    if (!alive.current) return;
    if (!res.ok) setIdentityError(res.error.message);
    setRemoveConfirm(false);
    await reload(next);
    if (alive.current) setBusy(false);
  };

  const fieldDefs = defaultFieldDefs(models, selected?.defaults ?? {}, IS_WINDOWS);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(860px, 94vw)',
          // maxHeight, not height (§8 C): a fixed height renders a full 620px panel
          // around a one-line "no projects yet" empty state.
          maxHeight: 'min(620px, 88vh)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-2)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: C.accent }}>PROJECTS</span>
          <span style={{ fontSize: 10, color: C.faint }}>{projectCountLabel(projects.length)}</span>
        </div>

        <div className="pj-body">
          {/* left: the registry (FR-33) */}
          <div className="pj-list">
            <div className="scz" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              {projects.length === 0 ? (
                <div style={{ padding: '14px 12px', fontSize: 11, color: C.faint }}>no projects yet</div>
              ) : (
                projects.map((p) => (
                  <ListRow
                    key={p.id}
                    project={p}
                    home={home}
                    selected={p.id === selectedId}
                    onClick={() => setSelectedId(p.id)}
                  />
                ))
              )}
            </div>
            {listError !== null && (
              <div style={{ padding: '6px 12px', fontSize: 10.5, color: C.error, flexShrink: 0 }}>{listError}</div>
            )}
            <NewProjectControl onClick={() => void addProject()} />
          </div>

          {/* right: the config form (FR-34) */}
          {selected && (
            <div
              className="scz"
              style={{
                flex: 1,
                overflow: 'auto',
                minHeight: 0,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                opacity: busy ? 0.6 : 1,
                pointerEvents: busy ? 'none' : undefined,
              }}
            >
              {/* IDENTITY — stays editable even when the root is gone (FR-38) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={groupLabelStyle}>IDENTITY</span>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={rowLabelStyle}>name</span>
                  <input
                    style={inputStyle}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={rowLabelStyle}>root</span>
                  <input
                    style={inputStyle}
                    value={rootDraft}
                    onChange={(e) => setRootDraft(e.target.value)}
                    onBlur={commitRoot}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
                {identityError !== null && <InlineError style={{ paddingLeft: 120 }}>{identityError}</InlineError>}
                {rootMissing && <InlineError style={{ paddingLeft: 120 }}>{ROOT_MISSING_LINE}</InlineError>}
              </div>

              {/* SESSION DEFAULTS — disabled while the root is missing (FR-38) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...disabledIf(rootMissing) }}>
                <span style={groupLabelStyle}>SESSION DEFAULTS</span>
                {fieldDefs.map((f) => {
                  const value = defaultsSelectValue(selected.defaults, f.key);
                  // §7 case 22: a stored default the catalog no longer offers has no
                  // matching <option>, so the select would silently render `inherit`
                  // and drop the value the moment it is touched. Surface it instead —
                  // the new-session modal already says so via `staleModelId`.
                  const stale = value !== '' && !f.options.some((o) => o.value === value);
                  return (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center' }}>
                      <span style={rowLabelStyle}>{f.label}</span>
                      <select
                        value={value}
                        onChange={(e) => commitDefault(f.key, e.target.value)}
                        style={{ ...inputStyle, color: value === '' ? C.faint : stale ? C.error : C.primary }}
                      >
                        {stale && <option value={value}>{`${value} (unavailable)`}</option>}
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
                {defaultsError !== null && <InlineError>{defaultsError}</InlineError>}
              </div>

              {/* STANDARDS — written into <root>/CLAUDE.md's managed block.
                  Disabled until the on-disk read lands (`standards === null`): an
                  interactive editor rendering from an empty fallback invites a commit
                  that would overwrite the real block. */}
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 8, ...disabledIf(rootMissing || standards === null) }}
              >
                <span style={groupLabelStyle}>STANDARDS</span>
                <textarea
                  value={notes}
                  placeholder="notes for every session in this project…"
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={commitNotes}
                  style={{
                    ...inputStyle,
                    flex: 'none',
                    minHeight: 64,
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                        commitRules(replaceRule(rules, i, editDraft));
                      }}
                      onUp={() => commitRules(moveRule(rules, i, -1))}
                      onDown={() => commitRules(moveRule(rules, i, 1))}
                      onDrop={() => commitRules(dropRule(rules, i))}
                    />
                  ))}
                  {rules.length === 0 && <span style={{ fontSize: 10.5, color: C.faint }}>no rules yet</span>}
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
                        if (newRule.trim() !== '') setStandardsError(`at most ${MAX_RULES} rules`);
                        return;
                      }
                      setNewRule('');
                      commitRules(next);
                    }}
                    style={{ ...inputStyle, flex: 'none' }}
                  />
                </div>

                {standardsError !== null && <InlineError>{standardsError}</InlineError>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: C.faint }}>
                  <span>{standardsFooterPath(selected.root)}</span>
                  <span>{STANDARDS_FOOTER_NOTE}</span>
                </div>
              </div>

              {/* REMOVE (FR-36) */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, paddingTop: 4 }}>
                {removeConfirm ? (
                  <>
                    <span style={{ fontSize: 10.5, color: C.error, textAlign: 'right' }}>
                      {removeConfirmText(selected.name)}
                    </span>
                    <Action color={C.dim} hoverColor={C.primary} onClick={() => setRemoveConfirm(false)}>
                      cancel
                    </Action>
                    <Action color={C.error} hoverColor="var(--error-bright)" onClick={() => void doRemove()}>
                      remove
                    </Action>
                  </>
                ) : (
                  <Action color={C.muted} hoverColor={C.error} onClick={() => setRemoveConfirm(true)}>
                    Remove
                  </Action>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** FR-38: Defaults + Standards are inert while the root is missing. */
function disabledIf(disabled: boolean): React.CSSProperties {
  return disabled ? { opacity: 0.45, pointerEvents: 'none' } : {};
}

function InlineError({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10.5, color: C.error, ...style }}>{children}</div>;
}

function ListRow({
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
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 44,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        padding: '8px 12px',
        cursor: 'pointer',
        background: selected ? 'var(--bg-raised)' : hover ? 'var(--bg-elevated)' : 'transparent',
        borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: selected ? C.bright : C.primary,
          }}
        >
          {project.name}
        </span>
        {!project.rootExists && <span style={{ fontSize: 9, color: C.error, flexShrink: 0 }}>missing</span>}
      </div>
      <span
        style={{ fontSize: 10, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {abbreviateRoot(project.root, home)}
      </span>
    </div>
  );
}

function NewProjectControl({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--border)',
        fontSize: 11,
        color: hover ? C.accent : C.dim,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      + New project
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
  onDraft: (v: string) => void;
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
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 26,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg-deep)',
        borderRadius: 4,
        padding: '6px 8px',
      }}
    >
      <span style={{ color: C.faint, fontSize: 11, flexShrink: 0 }}>-</span>
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
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--bg-app)',
            border: `1px solid ${C.accent}`,
            borderRadius: 3,
            padding: '2px 5px',
            fontSize: 11,
            color: C.bright,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      ) : (
        <span onClick={onEdit} style={{ flex: 1, minWidth: 0, fontSize: 11, color: C.primary, cursor: 'text' }}>
          {text}
        </span>
      )}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          opacity: showActions ? 1 : 0,
          transition: 'opacity 90ms ease-out',
          pointerEvents: showActions ? 'auto' : 'none',
        }}
      >
        <Action color={C.faint} hoverColor={C.accent} onClick={onUp} title="move rule up" size={10}>
          ↑
        </Action>
        <Action color={C.faint} hoverColor={C.accent} onClick={onDown} title="move rule down" size={10}>
          ↓
        </Action>
        <Action color={C.faint} hoverColor={C.error} onClick={onDrop} title="remove rule" size={10}>
          ×
        </Action>
      </span>
    </div>
  );
}

function Action({
  children,
  color,
  hoverColor,
  onClick,
  title,
  size = 10.5,
}: {
  children: React.ReactNode;
  color: string;
  hoverColor: string;
  onClick: () => void;
  title?: string;
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      role="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ fontSize: size, color: hover ? hoverColor : color, cursor: 'pointer', flexShrink: 0 }}
    >
      {children}
    </span>
  );
}

import type { RefObject } from 'react';
import { useState } from 'react';
import type { AppError, SkillInfo } from '../../../contract/common';
import type { CapabilityState } from '../../../contract/multi-provider-seam';
import { CapabilityNotice } from '../../ui/CapabilityNotice';
import { LoaderPane } from '../../ui/Loader';
import { ListRow } from '../../ui/ListRow';
import { isSkillRunnable, skillInvocationLabel, skillRowKey } from './skills-loaded';

// pi-skills-capabilities FR-1: 'path' is the Pi-only scope (a profile's skillPaths).
const scopeTag: Record<string, string> = { project: 'proj', user: 'user', plugin: 'plugin', path: 'path' };

export interface SkillsListBodyProps {
  /** multi-provider-openai FR-20: skills' capability state for this session. */
  capability: CapabilityState;
  /** multi-provider-openai FR-26: a SEPARATE capability from `capability` —
   *  `skills` can be available (the installed set is visible, injected into
   *  the model's system message) while `skillsInstall` stays a gap, because
   *  enabling a plugin writes Claude Code's own control surface. Gates the
   *  `enable` affordance on each uninstalled row. */
  installCapability: CapabilityState;
  filterOpen: boolean;
  query: string;
  filterRef: RefObject<HTMLInputElement>;
  onQueryChange: (query: string) => void;
  status: 'loading' | 'loaded' | 'error';
  listError: AppError | null;
  skills: SkillInfo[];
  visible: SkillInfo[];
  selected: number;
  onRowClick: (index: number, skill: SkillInfo) => void;
  /** pi-skills-capabilities FR-8: present only for a Pi session — the status
   *  line that keeps "no skills" from being confused with "project resources
   *  are disabled" (the empty state never has to infer it). */
}

/** Pane [5]'s scrollable skill/command list: the "/" filter row, its
 *  error/loading/empty states, and the row list itself. */
export function SkillsListBody({
  capability,
  installCapability,
  filterOpen,
  query,
  filterRef,
  onQueryChange,
  status,
  listError,
  skills,
  visible,
  selected,
  onRowClick,
}: SkillsListBodyProps): JSX.Element {
  return (
    <div className="scz skills-list">
      {filterOpen && (
        <div className="skills-filter">
          <span className="skills-filter-glyph">/</span>
          <input
            ref={filterRef}
            value={query}
            placeholder="filter skills…"
            onChange={(e) => onQueryChange(e.target.value)}
            className="skills-filter-input"
          />
          <span className="skills-filter-hint">esc clear</span>
        </div>
      )}

      {!capability.available ? (
        <CapabilityNotice reason={capability.reason ?? ''} />
      ) : status === 'error' ? (
        <div className="skills-error-row">
          <span className="skills-error-icon">⚠</span>
          <span className="skills-error-msg">{listError?.message ?? 'failed to load skills'} · ⏎ retry</span>
        </div>
      ) : status === 'loading' && skills.length === 0 ? (
        <LoaderPane size={16} label="Loading skills…" />
      ) : visible.length === 0 && query ? (
        <div className="skills-empty">no skills match "{query}"</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">no skills or commands found</div>
      ) : (
        visible.map((skill, i) => {
          const sel = i === selected;
          return (
            <Row
              key={skillRowKey(skill)}
              skill={skill}
              selected={sel}
              installCapability={installCapability}
              onClick={() => onRowClick(i, skill)}
            />
          );
        })
      )}
    </div>
  );
}

function Row({
  skill,
  selected,
  installCapability,
  onClick,
}: {
  skill: SkillInfo;
  selected: boolean;
  installCapability: CapabilityState;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  // pi-skills-capabilities FR-1: `loaded: false` is visible, never runnable —
  // dimmed, and its reason rides on `title` (same pattern as the disabled
  // `enable` affordance below).
  const runnable = isSkillRunnable(skill);
  const rowClassName = [
    'skills-row',
    selected ? 'skills-row--selected' : hover ? 'skills-row--hovered' : '',
    !runnable ? 'skills-row--unloaded' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <ListRow
      selected={selected}
      className={rowClassName}
      title={!runnable ? skill.unavailableReason : undefined}
      // B2: SELECT always happens (arrow-key navigation already lands here) —
      // activation stays gated inside SkillsPanel.activate, which is `onClick`
      // here, so a `loaded: false` row is never silently unresponsive to a
      // click, only to the activation it already refuses.
      aria-disabled={!runnable || undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={skill.installed ? 'skills-row-icon skills-row-icon--installed' : 'skills-row-icon'}>
        {skill.installed ? '✦' : '◇'}
      </span>
      <div className="skills-row-body">
        <div className={selected ? 'skills-row-name skills-row-name--selected' : 'skills-row-name'}>
          {skillInvocationLabel(skill)}
        </div>
        <div className="skills-row-desc truncate">
          {!runnable && skill.unavailableReason
            ? skill.unavailableReason
            : skill.description || (skill.kind === 'command' ? 'slash command' : 'skill')}
        </div>
      </div>
      <div className="skills-row-tags">
        {skill.kind === 'command' && <span className="skills-tag skills-tag--cmd">cmd</span>}
        {/* pi-skills-capabilities FR-1: a runtime-listed skill's own source (skill
            vs. prompt template), distinct from its scope tag below. */}
        {skill.source && <span className="skills-tag">{skill.source}</span>}
        {skill.scope && <span className="skills-tag">{scopeTag[skill.scope] ?? skill.scope}</span>}
        {!skill.installed && runnable && installCapability.available && <span className="skills-row-enable">enable</span>}
        {!skill.installed && runnable && !installCapability.available && (
          <span
            className="skills-row-enable skills-row-enable--disabled"
            title={installCapability.reason}
          >
            enable
          </span>
        )}
      </div>
    </ListRow>
  );
}

import { useState } from 'react';
import type { RefObject } from 'react';
import type { AppError, SkillInfo } from '../../../contract/common';
import { ListRow } from '../../ui/ListRow';

const scopeTag: Record<string, string> = { project: 'proj', user: 'user', plugin: 'plugin' };

export interface SkillsListBodyProps {
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
}

/** Pane [5]'s scrollable skill/command list: the "/" filter row, its
 *  error/loading/empty states, and the row list itself. */
export function SkillsListBody({
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

      {status === 'error' ? (
        <div className="skills-error-row">
          <span className="skills-error-icon">⚠</span>
          <span className="skills-error-msg">{listError?.message ?? 'failed to load skills'} · ⏎ retry</span>
        </div>
      ) : status === 'loading' && skills.length === 0 ? null : visible.length === 0 && query ? (
        <div className="skills-empty">no skills match "{query}"</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">no skills or commands found</div>
      ) : (
        visible.map((skill, i) => {
          const sel = i === selected;
          return <Row key={skill.name} skill={skill} selected={sel} onClick={() => onRowClick(i, skill)} />;
        })
      )}
    </div>
  );
}

function Row({ skill, selected, onClick }: { skill: SkillInfo; selected: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <ListRow
      selected={selected}
      className={`skills-row${selected ? ' skills-row--selected' : hover ? ' skills-row--hovered' : ''}`}
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
          {skill.kind === 'command' ? '/' : ''}
          {skill.name}
        </div>
        <div className="skills-row-desc truncate">
          {skill.description || (skill.kind === 'command' ? 'slash command' : 'skill')}
        </div>
      </div>
      <div className="skills-row-tags">
        {skill.kind === 'command' && <span className="skills-tag skills-tag--cmd">cmd</span>}
        {skill.scope && <span className="skills-tag">{scopeTag[skill.scope] ?? skill.scope}</span>}
        {!skill.installed && <span className="skills-row-enable">enable</span>}
      </div>
    </ListRow>
  );
}

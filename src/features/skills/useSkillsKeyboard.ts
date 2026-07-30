import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SkillInfo } from '../../../contract/common';
import { clampSelection, filterSkills } from './skills-filter';

export interface UseSkillsKeyboardOptions {
  sessionId: string | null;
  skills: SkillInfo[];
  status: 'loading' | 'loaded' | 'error';
  focused: boolean;
  modalOpen: boolean;
  refetch: (sid: string) => void;
  onActivate: (skill: SkillInfo) => void;
}

export interface SkillsKeyboard {
  visible: SkillInfo[];
  selected: number;
  setSelected: Dispatch<SetStateAction<number>>;
  filterOpen: boolean;
  setFilterOpen: Dispatch<SetStateAction<boolean>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  filterRef: RefObject<HTMLInputElement>;
}

/** The "/" filter bar, the selection cursor (clamped into range whenever the
 *  filtered list changes, via `clampSelection`), and pane [5]'s keyboard nav. */
export function useSkillsKeyboard(options: UseSkillsKeyboardOptions): SkillsKeyboard {
  const { sessionId, skills, status, focused, modalOpen, refetch, onActivate } = options;

  const [selected, setSelected] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Reset filter + selection on a session switch (mirrors SkillsPanel's original
  // per-session reset, which also cleared the skill list and any open modal —
  // those live in the feed hook and SkillsPanel respectively).
  useEffect(() => {
    setSelected(0);
    setFilterOpen(false);
    setQuery('');
  }, [sessionId]);

  const visible = useMemo(() => filterSkills(skills, query), [skills, query]);

  useEffect(() => {
    setSelected((i) => clampSelection(i, visible.length));
  }, [visible.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen) return;
      const inFilter = document.activeElement === filterRef.current;
      if (inFilter) {
        if (e.key === 'Escape') {
          setQuery('');
          setFilterOpen(false);
          setSelected(0);
          filterRef.current?.blur();
        }
        return;
      }
      if (!focused) return;
      if (status === 'error') {
        if (e.key === 'Enter' && sessionId) {
          e.preventDefault();
          refetch(sessionId);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (visible[selected]) {
          e.preventDefault();
          onActivate(visible[selected]);
        }
      } else if (e.key === '/') {
        e.preventDefault();
        setFilterOpen(true);
        setQuery('');
        requestAnimationFrame(() => filterRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, modalOpen, status, visible, selected, sessionId, refetch]);

  return { visible, selected, setSelected, filterOpen, setFilterOpen, query, setQuery, filterRef };
}

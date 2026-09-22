// projects — the Settings nav's "Project picker" (Figma 140:7640): the name of
// the project the project pages are editing, and a menu to pick another or add
// one. It is what remains of the Projects modal's left-hand registry list — the
// list moved behind the name, "+ New project" moved into the menu.

import { useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { Icon } from '../../ui/Icon';
import { abbreviateRoot } from './projects';
import type { ProjectSettings } from './useProjectSettings';
import './project-settings.css';

/** The menu's width (project-settings.css `.pj-picker__menu`), for keeping it inside the window. */
const MENU_WIDTH = 280;

export default function SettingsProjectPicker({ settings, home }: { settings: ProjectSettings; home: string }) {
  const { registry, mutations } = settings;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useDismiss(ref, { enabled: open, onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false) });

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const r = toggleRef.current?.getBoundingClientRect();
      if (!r) return;
      setPosition({ left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)), top: r.bottom + 4 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return (
    <div ref={ref} className="pj-picker">
      <button
        ref={toggleRef}
        type="button"
        className="pj-picker__toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Pick the project these pages edit"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pj-picker__name">{registry.selected?.name ?? 'None'}</span>
        <Icon name="chevron-down" size={10} />
      </button>
      {open && (
        <div
          className="pj-picker__menu"
          role="listbox"
          aria-label="Projects"
          style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
        >
          {registry.projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === registry.selectedId}
              className={p.id === registry.selectedId ? 'pj-picker__item pj-picker__item--selected' : 'pj-picker__item'}
              onClick={() => {
                registry.setSelectedId(p.id);
                setOpen(false);
              }}
            >
              <span className="pj-picker__item-name">{p.name}</span>
              {!p.rootExists && <span className="pj-picker__missing">missing</span>}
              <span className="pj-picker__item-root">{abbreviateRoot(p.root, home)}</span>
            </button>
          ))}
          <button
            type="button"
            className="pj-picker__item pj-picker__add"
            disabled={mutations.busy}
            onClick={() => {
              setOpen(false);
              void mutations.addProject();
            }}
          >
            <Icon name="plus" size={12} />
            <span className="pj-picker__item-name">New project…</span>
          </button>
        </div>
      )}
    </div>
  );
}

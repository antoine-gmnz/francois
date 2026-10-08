// Flow 2 — the root picker (§8: 28px, --bg-input, radius 6): folder icon, the root
// label, the branch, a chevron. Lists every project, then every session that has a
// worktree. Open tabs stay with their root; switching back restores them.

import { useMemo, useRef, useState } from 'react';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { useCodeStore } from './codeStore';
import { rootKey, rootOptions } from './editor-root';
import './code.css';

export default function RootPicker({ label, branch }: { label: string | null; branch: string | null }): JSX.Element {
  const root = useCodeStore((s) => s.root);
  const setRoot = useCodeStore((s) => s.setRoot);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, { enabled: open, onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false) });

  const options = useMemo(() => rootOptions(projects, sessions), [projects, sessions]);
  const currentKey = root ? rootKey(root) : null;
  const current = options.find((o) => o.key === currentKey);
  const shownLabel = label ?? current?.label ?? 'No root';
  const firstSession = options.findIndex((o) => o.root.kind === 'session');

  return (
    <div className="code-root" ref={ref}>
      <button type="button" className="code-root__button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="folder" size={14} className="code-root__icon" />
        <span className="code-root__label truncate">{shownLabel}</span>
        {branch && (
          <span className="code-root__branch truncate">
            <Icon name="branch" size={12} />
            {branch}
          </span>
        )}
        <Icon name="chevron-down" size={12} className="code-root__chevron" />
      </button>
      {open && (
        <ul className="code-root__menu" role="listbox" aria-label="Root">
          {options.length === 0 && <li className="code-root__empty">No projects registered.</li>}
          {options.map((o, i) => (
            <li key={o.key}>
              {i === firstSession && <div className="code-root__group">Session worktrees</div>}
              <button
                type="button"
                role="option"
                aria-selected={o.key === currentKey}
                className={o.key === currentKey ? 'code-root__option code-root__option--on' : 'code-root__option'}
                onClick={() => {
                  setRoot(o.root);
                  setOpen(false);
                }}
              >
                <span className="truncate">{o.label}</span>
                {o.branch && <span className="code-root__option-branch truncate">{o.branch}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

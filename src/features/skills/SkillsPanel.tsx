import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SkillInfo } from '../../../contract/common';
import { onSkillsEvent, skillsInstall, skillsList, skillsRun } from '../../lib/api';
import { setPaletteSkills } from '../palette/paletteData';
import { useStore } from '../../lib/store';
import { HintBar } from '../../ui/HintBar';
import { ListRow } from '../../ui/ListRow';
import { Modal, ModalHeader } from '../../ui/Modal';
import { PanelHeader } from '../../ui/PanelHeader';
import './skills.css';

const scopeTag: Record<string, string> = { project: 'proj', user: 'user', plugin: 'plugin' };

export default function SkillsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [listError, setListError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [runModal, setRunModal] = useState<{ name: string } | null>(null);
  const [installModal, setInstallModal] = useState<{ name: string; description: string; pluginId?: string } | null>(null);
  const focused = focusedPane === 'skills';
  const filterRef = useRef<HTMLInputElement>(null);
  const modalOpen = runModal !== null || installModal !== null;

  const refetch = useMemo(
    () => (sid: string, mountedRef?: { current: boolean }) => {
      setStatus('loading');
      void skillsList(sid).then((res) => {
        if (mountedRef && !mountedRef.current) return;
        if (res.ok) {
          setSkills(res.data);
          setPaletteSkills(sid, res.data); // feed the palette's run-skill secondary step (FR-19)
          setStatus('loaded');
          setListError(null);
        } else {
          setListError(res.error);
          setStatus('error');
        }
      });
    },
    [],
  );

  useEffect(() => {
    setSkills([]);
    setSelected(0);
    setFilterOpen(false);
    setQuery('');
    setRunModal(null);
    setInstallModal(null);
    if (!sessionId) {
      setStatus('loaded');
      return;
    }
    const mounted = { current: true };
    let unlisten: (() => void) | undefined;
    refetch(sessionId, mounted);
    void onSkillsEvent((e) => {
      if (e.type === 'skills.changed' && e.sessionId === sessionId) refetch(sessionId, mounted);
    }).then((u) => {
      if (!mounted.current) u();
      else unlisten = u;
    });
    return () => {
      mounted.current = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, refetch]);

  const visible = useMemo(() => {
    if (!query) return skills;
    const q = query.toLowerCase();
    return skills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  }, [skills, query]);

  useEffect(() => {
    setSelected((i) => Math.max(0, Math.min(i, visible.length - 1)));
  }, [visible.length]);

  const activate = (row: SkillInfo) => {
    if (row.installed) setRunModal({ name: row.name });
    else setInstallModal({ name: row.name, description: row.description, pluginId: row.pluginId });
  };

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
          activate(visible[selected]);
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

  return (
    <section onClick={() => setFocusedPane('skills')} className={focused ? 'skills-panel skills-panel--focused' : 'skills-panel'}>
      <PanelHeader title="SKILLS" count={skills.length} paneKey={5} focused={focused} />

      <div className="scz skills-list">
        {filterOpen && (
          <div className="skills-filter">
            <span className="skills-filter-glyph">/</span>
            <input
              ref={filterRef}
              value={query}
              placeholder="filter skills…"
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
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
            return (
              <Row
                key={skill.name}
                skill={skill}
                selected={sel}
                onClick={() => {
                  setFocusedPane('skills');
                  setSelected(i);
                  activate(skill);
                }}
              />
            );
          })
        )}
      </div>

      {runModal && sessionId && (
        <RunModal sessionId={sessionId} name={runModal.name} onClose={() => setRunModal(null)} />
      )}
      {installModal && sessionId && (
        <InstallModal
          sessionId={sessionId}
          name={installModal.name}
          description={installModal.description}
          pluginId={installModal.pluginId}
          onClose={() => setInstallModal(null)}
        />
      )}
    </section>
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

function RunModal({ sessionId, name, onClose }: { sessionId: string; name: string; onClose: () => void }) {
  const [args, setArgs] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const res = await skillsRun(sessionId, name, args);
    setPending(false);
    if (res.ok) onClose();
    else setError(res.error.message);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <Modal
      onClose={onClose}
      width={380}
      align="center"
      closeOnBackdropClick={true}
      closeOnEscape={false}
      className="skills-modal-backdrop"
    >
      <ModalHeader>
        <div className="skills-modal-title-row">
          <span className="skills-modal-glyph skills-modal-glyph--accent">✦</span>
          <span className="skills-modal-title skills-modal-title--flex">Run {name}</span>
          <span className="skills-modal-esc-hint">esc</span>
        </div>
      </ModalHeader>
      <div className="skills-run-row">
        <span className="skills-run-glyph">›</span>
        <input
          ref={inputRef}
          value={args}
          disabled={pending}
          placeholder="arguments (optional)"
          onChange={(e) => setArgs(e.target.value)}
          className={pending ? 'skills-run-input skills-run-input--pending' : 'skills-run-input'}
        />
      </div>
      {error && <div className="skills-modal-error">{error}</div>}
      <HintBar
        items={[
          { key: '⏎', label: 'run' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Modal>
  );
}

function optionClassName(selected: boolean, pending: boolean): string {
  const parts = ['skills-option'];
  if (selected) parts.push('skills-option--selected');
  if (pending) parts.push('skills-option--pending');
  return parts.join(' ');
}

function InstallModal({
  sessionId,
  name,
  description,
  pluginId,
  onClose,
}: {
  sessionId: string;
  name: string;
  description: string;
  pluginId?: string;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<'install' | 'cancel'>('install');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (c: 'install' | 'cancel' = choice) => {
    if (pending) return;
    if (c === 'cancel') {
      onClose();
      return;
    }
    setPending(true);
    setError(null);
    const res = await skillsInstall(sessionId, name);
    setPending(false);
    if (res.ok) onClose();
    else setError(res.error.message);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pending) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setChoice((c) => (c === 'install' ? 'cancel' : 'install'));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const option = (key: 'install' | 'cancel', glyph: string, label: string) => {
    const sel = choice === key;
    return (
      <div
        onClick={() => {
          setChoice(key);
          void confirm(key); // act on the clicked option, not the render-time choice
        }}
        onMouseEnter={() => setChoice(key)}
        className={optionClassName(sel, pending)}
      >
        <span className={sel ? 'skills-option-glyph skills-option-glyph--selected' : 'skills-option-glyph'}>{glyph}</span>
        <span className={sel ? 'skills-option-label skills-option-label--selected' : 'skills-option-label'}>{label}</span>
      </div>
    );
  };

  return (
    <Modal
      onClose={onClose}
      width={380}
      align="center"
      closeOnBackdropClick={true}
      closeOnEscape={false}
      className="skills-modal-backdrop"
    >
      <ModalHeader>
        <div className="skills-modal-title-row">
          <span className="skills-modal-glyph skills-modal-glyph--faint">◇</span>
          <span className="skills-modal-title">Enable {name}?</span>
        </div>
        {description && <div className="skills-install-desc">{description}</div>}
        <div className="skills-install-note">
          {pluginId ? (
            <>
              Turns on the <span className="skills-install-note-highlight">{pluginId}</span> plugin — its skills, commands, agents,{' '}
              <span className="skills-install-note-highlight">hooks, and MCP servers</span> — globally, for every Claude Code session
              (hooks can run shell commands on tool events). Applies on the next turn.
            </>
          ) : (
            'Enables this plugin — including any hooks and MCP servers — globally, for every Claude Code session.'
          )}
        </div>
      </ModalHeader>
      <div className="skills-options">
        {option('install', '＋', 'Enable plugin')}
        {option('cancel', '⊗', 'Cancel')}
      </div>
      {error && <div className="skills-modal-error">{error}</div>}
      <HintBar
        items={[
          { key: '↑↓', label: 'choose' },
          { key: '⏎', label: 'confirm' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { SkillInfo } from '../../../contract/common';
import { skillsInstall, skillsRun } from '../../lib/api';
import { useStore } from '../../lib/store';
import { HintBar } from '../../ui/HintBar';
import { Modal, ModalHeader } from '../../ui/Modal';
import { PanelHeader } from '../../ui/PanelHeader';
import { SkillsListBody } from './SkillsListBody';
import { useSkillsFeed } from './useSkillsFeed';
import { useSkillsKeyboard } from './useSkillsKeyboard';
import './skills.css';

export default function SkillsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const focused = focusedPane === 'skills';

  const { skills, status, listError, refetch } = useSkillsFeed(sessionId);

  const [runModal, setRunModal] = useState<{ name: string } | null>(null);
  const [installModal, setInstallModal] = useState<{ name: string; description: string; pluginId?: string } | null>(null);
  const modalOpen = runModal !== null || installModal !== null;

  // Close any open modal on a session switch (paired with useSkillsFeed's own
  // reset of the skill list and useSkillsKeyboard's reset of filter/selection).
  useEffect(() => {
    setRunModal(null);
    setInstallModal(null);
  }, [sessionId]);

  const activate = (row: SkillInfo) => {
    if (row.installed) setRunModal({ name: row.name });
    else setInstallModal({ name: row.name, description: row.description, pluginId: row.pluginId });
  };

  const { visible, selected, setSelected, filterOpen, setFilterOpen, query, setQuery, filterRef } = useSkillsKeyboard({
    sessionId,
    skills,
    status,
    focused,
    modalOpen,
    refetch,
    onActivate: activate,
  });

  return (
    <section onClick={() => setFocusedPane('skills')} className={focused ? 'skills-panel skills-panel--focused' : 'skills-panel'}>
      <PanelHeader title="SKILLS" count={skills.length} paneKey={5} focused={focused} />

      <SkillsListBody
        filterOpen={filterOpen}
        query={query}
        filterRef={filterRef}
        onQueryChange={(q) => {
          setQuery(q);
          setSelected(0);
        }}
        status={status}
        listError={listError}
        skills={skills}
        visible={visible}
        selected={selected}
        onRowClick={(i, skill) => {
          setFocusedPane('skills');
          setSelected(i);
          activate(skill);
        }}
      />

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

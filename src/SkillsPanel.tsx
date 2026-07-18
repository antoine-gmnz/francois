import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SkillInfo } from '../contract/common';
import { onSkillsEvent, skillsInstall, skillsList, skillsRun } from './api';
import { setPaletteSkills } from './paletteData';
import { useStore } from './store';

const C = {
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
  installed: '#7fa07a',
  error: '#c46b62',
};

const scopeTag: Record<string, string> = { project: 'proj', user: 'user', plugin: 'plugin' };

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 8.5,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color,
    border: '1px solid #2a2c33',
    borderRadius: 3,
    padding: '1px 4px',
    flexShrink: 0,
    lineHeight: 1.4,
  };
}

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
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
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
    <section
      onClick={() => setFocusedPane('skills')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#16171c',
        border: `1px solid ${focused ? C.accent : '#2a2c33'}`,
        borderRadius: 5,
        overflow: 'hidden',
        minHeight: 0,
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid #24262d',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          SKILLS
        </span>
        <span style={{ fontSize: 10, color: C.faint }}>{skills.length} · [5]</span>
      </div>

      <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {filterOpen && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderBottom: '1px solid #24262d',
              margin: '-6px -8px 6px',
            }}
          >
            <span style={{ fontSize: 12, color: C.accent }}>/</span>
            <input
              ref={filterRef}
              value={query}
              placeholder="filter skills…"
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#d3d6dc', fontSize: 11.5, fontFamily: 'inherit' }}
            />
            <span style={{ fontSize: 9, color: '#3a3d45' }}>esc clear</span>
          </div>
        )}

        {status === 'error' ? (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 6px', background: '#20222a', borderLeft: '2px solid #c46b62' }}
          >
            <span style={{ width: 14, textAlign: 'center', fontSize: 11, color: C.error }}>⚠</span>
            <span style={{ fontSize: 11, color: C.error, flex: 1 }}>{listError?.message ?? 'failed to load skills'} · ⏎ retry</span>
          </div>
        ) : status === 'loading' && skills.length === 0 ? null : visible.length === 0 && query ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 11, color: C.faint }}>no skills match "{query}"</div>
        ) : skills.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 11, color: C.faint }}>no skills or commands found</div>
        ) : (
          visible.map((s, i) => {
            const sel = i === selected;
            return (
              <Row
                key={s.name}
                s={s}
                selected={sel}
                onClick={() => {
                  setFocusedPane('skills');
                  setSelected(i);
                  activate(s);
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

function Row({ s, selected, onClick }: { s: SkillInfo; selected: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: selected ? '8px 6px 8px 4px' : '8px 6px',
        borderBottom: '1px solid #1d1f25',
        borderLeft: selected ? '2px solid #c8a15a' : 'none',
        background: selected ? '#20222a' : hover ? '#1a1c22' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 14, textAlign: 'center', fontSize: 11, color: s.installed ? C.accent : C.faint, flexShrink: 0 }}>
        {s.installed ? '✦' : '◇'}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, color: selected ? C.bright : C.primary }}>
          {s.kind === 'command' ? '/' : ''}
          {s.name}
        </div>
        <div style={{ fontSize: 10, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1, minHeight: 12 }}>
          {s.description || (s.kind === 'command' ? 'slash command' : 'skill')}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {s.kind === 'command' && <span style={badgeStyle('#7c8aa0')}>cmd</span>}
        {s.scope && <span style={badgeStyle(C.faint)}>{scopeTag[s.scope] ?? s.scope}</span>}
        {!s.installed && <span style={{ fontSize: 9.5, letterSpacing: '0.04em', color: C.accent }}>enable</span>}
      </div>
    </div>
  );
}

function ModalShell({ width, children, onClose }: { width: number; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(6,7,9,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width, background: '#191b21', border: '1px solid #34363f', borderRadius: 8, overflow: 'hidden', boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)' }}
      >
        {children}
      </div>
    </div>
  );
}

function Footer({ hints }: { hints: [string, string][] }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '9px 16px', borderTop: '1px solid #24262d', fontSize: 10, color: C.faint }}>
      {hints.map(([k, label]) => (
        <span key={label}>
          <span style={{ color: C.dim }}>{k}</span> {label}
        </span>
      ))}
    </div>
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
    <ModalShell width={380} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid #24262d' }}>
        <span style={{ color: C.accent, fontSize: 13 }}>✦</span>
        <span style={{ fontSize: 14, color: '#d3d6dc', flex: 1 }}>Run {name}</span>
        <span style={{ fontSize: 10, color: C.faint }}>esc</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 16px' }}>
        <span style={{ color: C.accent, fontSize: 13 }}>›</span>
        <input
          ref={inputRef}
          value={args}
          disabled={pending}
          placeholder="arguments (optional)"
          onChange={(e) => setArgs(e.target.value)}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#d3d6dc', fontSize: 12.5, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
        />
      </div>
      {error && <div style={{ padding: '0 16px 10px', fontSize: 10.5, color: C.error }}>{error}</div>}
      <Footer hints={[['⏎', 'run'], ['esc', 'cancel']]} />
    </ModalShell>
  );
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
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 5, background: sel ? '#26282f' : 'transparent', cursor: 'pointer', opacity: pending ? 0.5 : 1 }}
      >
        <span style={{ width: 16, textAlign: 'center', fontSize: 12, color: sel ? C.accent : C.faint }}>{glyph}</span>
        <span style={{ fontSize: 13, color: sel ? C.bright : C.primary }}>{label}</span>
      </div>
    );
  };

  return (
    <ModalShell width={380} onClose={onClose}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #24262d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: C.faint, fontSize: 13 }}>◇</span>
          <span style={{ fontSize: 14, color: '#d3d6dc' }}>Enable {name}?</span>
        </div>
        {description && <div style={{ fontSize: 11, color: C.dim, marginTop: 3, marginLeft: 23 }}>{description}</div>}
        <div style={{ fontSize: 10.5, color: C.faint, marginTop: 6, marginLeft: 23 }}>
          {pluginId ? (
            <>
              Turns on the <span style={{ color: C.dim }}>{pluginId}</span> plugin — its skills, commands, agents,{' '}
              <span style={{ color: C.dim }}>hooks, and MCP servers</span> — globally, for every Claude Code session
              (hooks can run shell commands on tool events). Applies on the next turn.
            </>
          ) : (
            'Enables this plugin — including any hooks and MCP servers — globally, for every Claude Code session.'
          )}
        </div>
      </div>
      <div style={{ padding: 6 }}>
        {option('install', '＋', 'Enable plugin')}
        {option('cancel', '⊗', 'Cancel')}
      </div>
      {error && <div style={{ padding: '0 16px 10px', fontSize: 10.5, color: C.error }}>{error}</div>}
      <Footer hints={[['↑↓', 'choose'], ['⏎', 'confirm'], ['esc', 'cancel']]} />
    </ModalShell>
  );
}

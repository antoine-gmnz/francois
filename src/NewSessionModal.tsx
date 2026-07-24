import { useEffect, useRef, useState } from 'react';
import type { AppError, ClaudeRuntime, ModelInfo, PermissionMode, SessionMeta } from '../contract/common';
import { isWslUncPath } from '../contract/wsl-filesystem';
import { sessionCreate, sessionModels, sessionPickDirectory } from './api';
import ModelPicker from './ModelPicker';

// PermissionMode choices (contract/common.ts): label + the plain-language consequence.
const PERMISSION_OPTIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'default', hint: 'inherit your Claude settings (~/.claude)' },
  { mode: 'plan', label: 'plan', hint: 'read & plan only — never edits or runs commands' },
  { mode: 'acceptEdits', label: 'accept edits', hint: 'auto-approve file edits; other tools follow your settings' },
  { mode: 'bypassPermissions', label: 'bypass', hint: 'skip every permission check — full access' },
];

const IS_WINDOWS = navigator.userAgent.includes('Windows');

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-strong)',
  error: 'var(--error)',
};

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const fieldStyle: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  height: 32,
  color: C.primary,
  fontSize: 12.5,
  fontFamily: 'inherit',
  padding: '0 10px',
  width: '100%',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: C.dim,
  letterSpacing: '0.08em',
  marginBottom: 5,
  display: 'block',
};

export default function NewSessionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (m: SessionMeta) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState(''); // '' = model default
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [allowGit, setAllowGit] = useState(false);
  const [runtime, setRuntime] = useState<ClaudeRuntime>('native');
  // Reset each modal open (component remounts per open — see App.tsx). Tracks
  // whether the user has explicitly clicked a runtime chip this open, so
  // FR-16's auto-suggest never clobbers a deliberate choice.
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);
  const [pickerError, setPickerError] = useState<AppError | null>(null);
  const [picking, setPicking] = useState(false);
  const openRef = useRef(true);

  useEffect(() => {
    void sessionModels().then((res) => {
      setModelsLoading(false);
      if (res.ok) {
        setModels(res.data);
        if (res.data[0]) setModelId(res.data[0].id);
      }
    });
    return () => {
      openRef.current = false;
    };
  }, []);

  const modelEfforts = models.find((m) => m.id === modelId)?.efforts ?? [];

  // Reset effort if the newly selected model doesn't support the current level.
  useEffect(() => {
    if (effort && !modelEfforts.includes(effort)) setEffort('');
  }, [modelId, models]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared by Browse and direct typing: keep the derived name and the FR-16
  // runtime auto-suggest in sync with the path. The suggest follows the path in
  // BOTH directions (wsl for a WSL UNC path, back to native otherwise) but only
  // while the user hasn't explicitly clicked a runtime chip this modal-open.
  const applyCwd = (path: string) => {
    setCwd(path);
    if (!nameTouched) setName(basename(path));
    if (IS_WINDOWS && !runtimeTouched) setRuntime(isWslUncPath(path) ? 'wsl' : 'native');
  };

  const browse = async () => {
    if (picking) return;
    setPicking(true);
    setPickerError(null);
    const res = await sessionPickDirectory();
    setPicking(false);
    if (!res.ok) {
      setPickerError(res.error);
      return;
    }
    if (res.data === null) return; // cancelled
    applyCwd(res.data.path);
  };

  const canCreate = cwd.trim() !== '' && name.trim() !== '' && modelId !== '' && !submitting;
  // FR-16/17: whether the picked directory is a WSL UNC path, drives the
  // auto-suggest + mismatch hints below the CLAUDE RUNTIME row.
  const cwdIsWsl = isWslUncPath(cwd);

  const submit = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    const res = await sessionCreate({
      cwd: cwd.trim(),
      name,
      modelId,
      effort: effort || undefined,
      permissionMode: permissionMode !== 'default' ? permissionMode : undefined,
      runtime: runtime !== 'native' ? runtime : undefined,
      allowGit: allowGit || undefined,
    });
    if (!openRef.current) {
      // Modal was cancelled mid-flight: still real, upsert but don't force-select.
      if (res.ok) onCreated(res.data);
      return;
    }
    setSubmitting(false);
    if (res.ok) {
      onCreated(res.data);
      onClose();
    } else {
      setSubmitError(res.error);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && canCreate) {
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.tagName !== 'SELECT') {
          e.preventDefault();
          void submit();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,7,9,0.62)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 118,
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          background: 'var(--bg-panel)',
          border: '1px solid var(--bg-hover-2)',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontSize: 14, color: C.bright }}>
          <span style={{ color: C.accent }}>›</span> new session
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>DIRECTORY</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {/* Editable, not browse-only: on some setups the native picker can't
                  reach a location (e.g. WSL's Linux section on older Windows
                  builds) — typing/pasting the path must always work as a fallback. */}
              <input
                style={{ ...fieldStyle, flex: 1 }}
                value={cwd}
                placeholder="type a path or browse…"
                onChange={(e) => applyCwd(e.target.value)}
              />
              <button onClick={browse} disabled={picking} style={btn(false)}>
                {picking ? '…' : 'Browse…'}
              </button>
            </div>
            {pickerError && <div style={{ fontSize: 10.5, color: C.error, marginTop: 4 }}>{pickerError.message}</div>}
          </div>

          <div>
            <label style={labelStyle}>NAME</label>
            <input
              style={fieldStyle}
              value={name}
              placeholder="session name"
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>

          <div>
            <label style={labelStyle}>MODEL</label>
            <ModelPicker models={models} modelId={modelId} loading={modelsLoading} onChange={setModelId} />
          </div>

          {modelEfforts.length > 0 && (
            <div>
              <label style={labelStyle}>EFFORT</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[{ k: 'default', v: '' }, ...modelEfforts.map((e) => ({ k: e, v: e }))].map(({ k, v }) => {
                  const sel = effort === v;
                  return (
                    <span
                      key={k}
                      onClick={() => setEffort(v)}
                      style={{
                        fontSize: 11,
                        padding: '4px 9px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        border: `1px solid ${sel ? C.accent : 'var(--border-2)'}`,
                        background: sel ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                        color: sel ? C.accent : C.dim,
                      }}
                    >
                      {k}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label style={labelStyle}>PERMISSIONS</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {PERMISSION_OPTIONS.map(({ mode, label }) => {
                const sel = permissionMode === mode;
                const danger = mode === 'bypassPermissions';
                return (
                  <span
                    key={mode}
                    onClick={() => setPermissionMode(mode)}
                    style={{
                      fontSize: 11,
                      padding: '4px 9px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      border: `1px solid ${sel ? (danger ? C.error : C.accent) : 'var(--border-2)'}`,
                      background: sel ? (danger ? 'color-mix(in srgb, var(--error) 12%, transparent)' : 'color-mix(in srgb, var(--accent) 12%, transparent)') : 'var(--bg-panel)',
                      color: sel ? (danger ? C.error : C.accent) : C.dim,
                    }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
              {PERMISSION_OPTIONS.find((o) => o.mode === permissionMode)?.hint}
            </div>
          </div>

          <div>
            <label style={labelStyle}>GIT</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <span
                onClick={() => setAllowGit((v) => !v)}
                style={{
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: `1px solid ${allowGit ? C.accent : 'var(--border-2)'}`,
                  background: allowGit ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                  color: allowGit ? C.accent : C.dim,
                }}
              >
                {allowGit ? '✓ ' : ''}allow git commands
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
              auto-approve git &amp; gh commands (commit, push, PRs) without a prompt — other tools still follow the permission setting above
            </div>
          </div>

          {IS_WINDOWS && (
            <div>
              <label style={labelStyle}>CLAUDE RUNTIME</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['native', 'wsl'] as const).map((r) => {
                  const sel = runtime === r;
                  return (
                    <span
                      key={r}
                      onClick={() => {
                        setRuntime(r);
                        setRuntimeTouched(true);
                      }}
                      style={{
                        fontSize: 11,
                        padding: '4px 9px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        border: `1px solid ${sel ? C.accent : 'var(--border-2)'}`,
                        background: sel ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                        color: sel ? C.accent : C.dim,
                      }}
                    >
                      {r}
                    </span>
                  );
                })}
              </div>
              {/* FR-16/17: mutually exclusive, below the row — never blocks creation. */}
              {runtime === 'wsl' ? (
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
                  {cwdIsWsl
                    ? 'WSL directory — claude will run inside your default distro'
                    : 'runs `claude` inside your default WSL distro (wsl.exe translates the directory)'}
                </div>
              ) : (
                cwdIsWsl && (
                  <div style={{ fontSize: 10.5, color: C.error, marginTop: 5 }}>
                    Windows tools will access this directory over 9P — expect slow git and no live diff updates
                  </div>
                )
              )}
            </div>
          )}

          {submitError && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--error) 9%, transparent)',
                color: C.error,
                fontSize: 11,
                borderRadius: 4,
                padding: '8px 10px',
              }}
            >
              {submitError.message}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '9px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <button onClick={onClose} style={btn(false, C.dim)}>
            Cancel
          </button>
          <button onClick={submit} disabled={!canCreate} style={createBtn(canCreate)}>
            {submitting ? 'creating…' : 'Create session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function btn(_active: boolean, color = C.primary): React.CSSProperties {
  return {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-2)',
    borderRadius: 4,
    color,
    fontSize: 12,
    fontFamily: 'inherit',
    padding: '0 12px',
    height: 32,
    cursor: 'pointer',
  };
}

function createBtn(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? C.accent : 'var(--text-disabled)',
    border: 'none',
    borderRadius: 4,
    color: enabled ? 'var(--bg-panel)' : 'var(--text-muted)',
    fontSize: 12,
    fontFamily: 'inherit',
    fontWeight: 600,
    padding: '0 14px',
    height: 32,
    cursor: enabled ? 'pointer' : 'default',
  };
}

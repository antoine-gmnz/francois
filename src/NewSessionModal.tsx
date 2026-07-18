import { useEffect, useRef, useState } from 'react';
import type { AppError, ModelInfo, SessionMeta } from '../contract/common';
import { sessionCreate, sessionModels, sessionPickDirectory } from './api';
import ModelPicker from './ModelPicker';

const C = {
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#d3d6dc',
  error: '#c46b62',
};

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const fieldStyle: React.CSSProperties = {
  background: '#1a1c22',
  border: '1px solid #2a2c33',
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
    const path = res.data.path;
    setCwd(path);
    if (!nameTouched) setName(basename(path));
  };

  const canCreate = cwd.trim() !== '' && name.trim() !== '' && modelId !== '' && !submitting;

  const submit = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    const res = await sessionCreate({ cwd, name, modelId, effort: effort || undefined });
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
          background: '#191b21',
          border: '1px solid #34363f',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #24262d', fontSize: 14, color: C.bright }}>
          <span style={{ color: C.accent }}>›</span> new session
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>DIRECTORY</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <div
                onClick={browse}
                style={{
                  ...fieldStyle,
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  color: cwd ? C.primary : C.faint,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {cwd || 'choose a working directory…'}
              </div>
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
                        border: `1px solid ${sel ? C.accent : '#2a2c33'}`,
                        background: sel ? 'rgba(200,161,90,0.12)' : '#1a1c22',
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

          {submitError && (
            <div
              style={{
                background: 'rgba(196,107,98,0.09)',
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
            borderTop: '1px solid #24262d',
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
    background: '#1a1c22',
    border: '1px solid #2a2c33',
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
    background: enabled ? C.accent : '#3a3d45',
    border: 'none',
    borderRadius: 4,
    color: enabled ? '#191b21' : '#6b7079',
    fontSize: 12,
    fontFamily: 'inherit',
    fontWeight: 600,
    padding: '0 14px',
    height: 32,
    cursor: enabled ? 'pointer' : 'default',
  };
}

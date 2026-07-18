import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../contract/common';

const C = {
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
};

const fieldStyle: React.CSSProperties = {
  background: '#1a1c22',
  border: '1px solid #2a2c33',
  borderRadius: 4,
  height: 32,
  color: C.primary,
  fontSize: 12.5,
  padding: '0 10px',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

// No overflow:hidden here — the submenu must be able to fly out to the side.
const panelStyle: React.CSSProperties = {
  background: '#191b21',
  border: '1px solid #34363f',
  borderRadius: 6,
  boxShadow: '0 20px 50px -18px rgba(0,0,0,0.85)',
};

function familyOf(m: ModelInfo): string {
  return m.label.split(' ')[0] || m.label;
}

export default function ModelPicker({
  models,
  modelId,
  onChange,
  loading,
}: {
  models: ModelInfo[];
  modelId: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const selected = models.find((m) => m.id === modelId) ?? null;

  const families = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const f = familyOf(m);
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push(m);
    }
    return Array.from(map, ([family, items]) => ({ family, items }));
  }, [models]);

  const disabled = loading || models.length === 0;

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    setHovered(families[0]?.family ?? null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef}>
      <div
        ref={triggerRef}
        onClick={toggle}
        style={{ ...fieldStyle, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.7 : 1 }}
      >
        <span style={{ flex: 1, color: selected ? C.primary : C.faint }}>
          {loading ? 'loading…' : models.length === 0 ? 'no models available' : selected ? selected.label : 'select a model'}
        </span>
        <span style={{ color: C.faint, fontSize: 10 }}>▾</span>
      </div>

      {selected?.brief && !open && <div style={{ fontSize: 10, color: C.faint, marginTop: 5 }}>{selected.brief}</div>}

      {open && rect && (
        <div style={{ ...panelStyle, position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 40 }}>
          {families.map(({ family, items }) => {
            const active = hovered === family;
            const familySelected = items.some((m) => m.id === modelId);
            return (
              <div
                key={family}
                onMouseEnter={() => setHovered(family)}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  background: active ? '#26282f' : 'transparent',
                  borderLeft: `2px solid ${familySelected ? C.accent : 'transparent'}`,
                }}
              >
                <span style={{ flex: 1, fontSize: 12, color: familySelected ? C.bright : C.primary, fontWeight: 500 }}>
                  {family}
                </span>
                <span style={{ fontSize: 10, color: C.faint }}>{items.length > 1 ? `${items.length} ` : ''}›</span>

                {active && (
                  <div
                    className="scz"
                    style={{
                      ...panelStyle,
                      position: 'absolute',
                      left: '100%',
                      top: -1,
                      marginLeft: 3,
                      minWidth: 260,
                      maxHeight: '60vh',
                      overflowY: 'auto',
                    }}
                  >
                    {items.map((m) => {
                      const isSel = m.id === modelId;
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            onChange(m.id);
                            setOpen(false);
                          }}
                          style={{
                            padding: '8px 11px',
                            cursor: 'pointer',
                            background: isSel ? '#20222a' : 'transparent',
                            borderLeft: `2px solid ${isSel ? C.accent : 'transparent'}`,
                          }}
                          onMouseEnter={(e) => {
                            if (!isSel) e.currentTarget.style.background = '#26282f';
                          }}
                          onMouseLeave={(e) => {
                            if (!isSel) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <div style={{ fontSize: 12, color: isSel ? C.bright : C.primary }}>{m.label}</div>
                          {m.brief && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{m.brief}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

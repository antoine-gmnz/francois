// interactive-commands — command card renderer for the SESSION transcript
// (spec §8 design brief, verbatim tokens). One component per card kind inside
// the bordered container; the notice kind is NOT a card (dim glyph-column
// one-liner, same layout as tool blocks). The model card is the only
// interactive card (FR-21): its current marker derives live from the store's
// SessionMeta.model.id, and clicking a non-current row invokes
// francois:session:switchModel.

import { Fragment, useEffect, useRef, useState } from 'react';
import type { CommandCard, HelpEntry, SessionMeta, SessionStatus } from '../contract/common';
import { formatContextTokens } from '../contract/conversation-view';
import type { CommandConversationBlock } from '../contract/interactive-commands';
import { displayWslCwd } from '../contract/wsl-filesystem';
import { sessionSwitchModel } from './api';
import { cardHeaderLabel, liveCurrentModelId, meterFillColor, switchModelFromCard } from './conversation-blocks';
import { useStore } from './store';

// §8 tokens
const T = {
  cardBg: '#17191f',
  border: '#24262d',
  accent: '#c8a15a',
  name: '#868a93',
  faint: '#565a63',
  dim: '#868a93',
  body: '#b9bcc4',
  bright: '#dfe2e8',
  value: '#c4c7ce',
  error: '#c46b62',
  loading: '#c2b06a',
  hover: '#20222a',
  green: '#7fa07a',
};

const STATUS_COLOR: Record<SessionStatus, string> = {
  running: '#c8a15a',
  idle: '#7fa07a',
  done: '#565a63',
  error: '#c46b62',
};

export default function CommandBlock({ b, sessionId }: { b: CommandConversationBlock; sessionId: string }) {
  const card = b.card;

  // Notice: NOT a card — glyph-column one-liner identical to tool blocks (§8).
  if (card?.kind === 'notice') {
    return (
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ width: 16, flexShrink: 0, textAlign: 'center', fontSize: 12, color: T.faint, marginTop: 1 }}>▦</span>
        <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, lineHeight: 1.55, color: T.dim, whiteSpace: 'pre-wrap' }}>{card.text}</div>
      </div>
    );
  }

  const label = cardHeaderLabel(card, b.command); // falls back to 'OUTPUT' when both resolve empty

  return (
    <div style={{ background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 4, padding: '10px 13px' }}>
      {/* header: glyph + command name; loading adds the right-aligned pulse */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: T.accent }}>▦</span>
        <span style={{ fontSize: 10, letterSpacing: '0.12em', color: T.name }}>{label}</span>
        {!card && (
          <>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{ width: 5, height: 5, borderRadius: '50%', background: T.loading, animation: 'pulse 1.4s ease-in-out infinite' }}
              />
              <span style={{ fontSize: 9.5, letterSpacing: '0.04em', color: T.loading }}>running…</span>
            </span>
          </>
        )}
      </div>

      {!card ? (
        <div style={{ fontSize: 12, color: T.faint }}>fetching…</div>
      ) : card.kind === 'usage' ? (
        <UsageBody card={card} />
      ) : card.kind === 'context' ? (
        <ContextBody card={card} />
      ) : card.kind === 'model' ? (
        <ModelBody card={card} sessionId={sessionId} />
      ) : card.kind === 'status' ? (
        <StatusBody meta={card.meta} />
      ) : card.kind === 'help' ? (
        <HelpBody entries={card.entries} />
      ) : (
        <PreBody text={card.text} />
      )}
    </div>
  );
}

/** Label above, then bar (flex) + right-side text; reset text wraps under the bar on narrow panes. */
function MeterRow({ label, percent, right }: { label: string; percent: number; right: React.ReactNode }) {
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div style={{ fontSize: 11, color: T.body, marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 120, height: 6, borderRadius: 3, background: T.border }}>
          <div style={{ width: `${p}%`, height: '100%', borderRadius: 3, background: meterFillColor(percent) }} />
        </div>
        {right}
      </div>
    </div>
  );
}

function UsageBody({ card }: { card: Extract<CommandCard, { kind: 'usage' }> }) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {card.meters.map((m, i) => (
          <MeterRow
            key={i}
            label={m.label}
            percent={m.percentUsed}
            right={
              <>
                <span style={{ fontSize: 11, color: T.bright }}>{m.percentUsed}%</span>
                <span style={{ fontSize: 10, color: T.faint }}>resets {m.resetsAt}</span>
              </>
            }
          />
        ))}
      </div>
      {card.tail && (
        <div style={{ marginTop: 8, fontSize: 12, color: T.body, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{card.tail}</div>
      )}
    </>
  );
}

function ContextBody({ card }: { card: Extract<CommandCard, { kind: 'context' }> }) {
  return (
    <>
      {card.percentUsed !== null && (
        <MeterRow
          label="context"
          percent={card.percentUsed}
          right={
            <span style={{ fontSize: 11 }}>
              <span style={{ color: T.bright }}>{card.usedLabel}</span>
              <span style={{ color: T.faint }}>/{card.limitLabel}</span>
            </span>
          }
        />
      )}
      <PreBody text={card.body} top={card.percentUsed !== null ? 8 : 0} />
    </>
  );
}

function ModelBody({ card, sessionId }: { card: Extract<CommandCard, { kind: 'model' }>; sessionId: string }) {
  const live = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const currentId = liveCurrentModelId(live?.model.id, card.currentId); // FR-21: live, never the snapshot
  const disabled = live?.status === 'done' || live?.status === 'error';
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const schedule = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };

  return (
    <div>
      {card.models.map((m) => {
        const isCurrent = m.id === currentId;
        const interactive = !disabled && !isCurrent;
        return (
          <div
            key={m.id}
            onClick={() =>
              void switchModelFromCard({
                disabled,
                currentId,
                modelId: m.id,
                switchModel: (modelId) => sessionSwitchModel(sessionId, modelId),
                setError,
                schedule,
              })
            }
            onMouseEnter={interactive ? (e) => (e.currentTarget.style.background = T.hover) : undefined}
            onMouseLeave={interactive ? (e) => (e.currentTarget.style.background = 'transparent') : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 8px',
              borderRadius: 3,
              cursor: interactive ? 'pointer' : 'default',
              opacity: disabled && !isCurrent ? 0.5 : 1,
            }}
          >
            <span style={{ fontSize: 12, color: isCurrent ? T.green : T.faint }}>{isCurrent ? '●' : '○'}</span>
            <span style={{ fontSize: 12, color: isCurrent ? T.bright : T.body }}>{m.label}</span>
            {isCurrent && <span style={{ fontSize: 10, color: T.faint }}>current</span>}
          </div>
        );
      })}
      {error && <div style={{ marginTop: 4, fontSize: 10.5, color: T.error }}>{error}</div>}
    </div>
  );
}

function StatusBody({ meta }: { meta: SessionMeta }) {
  const rows: [string, React.ReactNode][] = [
    ['name', meta.name],
    ['cwd', <span style={{ overflowWrap: 'anywhere' }}>{displayWslCwd(meta.cwd) ?? meta.cwd}</span>],
    ['model', meta.model.label],
    ['status', <span style={{ color: STATUS_COLOR[meta.status] }}>{meta.status}</span>],
    ['runtime', meta.runtime],
    ['permissions', meta.permissionMode],
    [
      'ctx',
      <span>
        <span style={{ color: T.bright }}>{formatContextTokens(meta.contextUsedTokens)}</span>
        <span style={{ color: T.faint }}>/{formatContextTokens(meta.contextLimitTokens)}</span>
      </span>,
    ],
    ['started', new Date(meta.startedAt).toLocaleString()],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px' }}>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span style={{ fontSize: 10.5, color: T.faint }}>{k}</span>
          <span style={{ fontSize: 12, color: T.value, minWidth: 0 }}>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

function HelpBody({ entries }: { entries: HelpEntry[] }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2 }}>
        {entries.map((e) => (
          <Fragment key={e.command}>
            <span style={{ fontSize: 12, color: T.accent }}>/{e.command}</span>
            <span style={{ fontSize: 12, color: T.dim }}>{e.description}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 10.5, color: T.faint }}>other /commands are passed to Claude Code</div>
    </div>
  );
}

/** Preformatted body (context/text cards): horizontal scroll inside the card only. */
function PreBody({ text, top = 0 }: { text: string; top?: number }) {
  return (
    <div
      className="scz"
      style={{ marginTop: top, fontSize: 12, color: T.body, lineHeight: 1.5, whiteSpace: 'pre', overflowX: 'auto' }}
    >
      {text}
    </div>
  );
}

// interactive-commands — command card renderer for the SESSION transcript
// (spec §8 design brief, verbatim tokens). One component per card kind inside
// the bordered container; the notice kind is NOT a card (dim glyph-column
// one-liner, same layout as tool blocks). The model card is the only
// interactive card (FR-21): its current marker derives live from the store's
// SessionMeta.model.id, and clicking a non-current row invokes
// francois:session:switchModel.

import { Fragment, useEffect, useRef, useState } from 'react';
import type { CommandCard, HelpEntry, SessionMeta, SessionStatus } from '../../../contract/common';
import { formatContextTokens } from '../../../contract/conversation-view';
import { isTerminalStatus } from '../../../contract/fleet-board';
import type { CommandConversationBlock } from '../../../contract/interactive-commands';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { sessionSwitchModel } from '../../lib/api';
import { CARD_KIND_COMMAND, cardHeaderLabel, liveCurrentModelId, meterFillColor, switchModelFromCard } from '../conversation/conversation-blocks';
import { useStore } from '../../lib/store';
import './commands.css';

// The token mirror of contract/fleet-board.ts's STATUS_COLOR — same assignments,
// as CSS vars so the /status card follows the light theme.
const STATUS_COLOR: Record<SessionStatus, string> = {
  starting: 'var(--accent-dim)',
  running: 'var(--accent)',
  awaiting_approval: 'var(--attn)',
  awaiting_input: 'var(--warn)',
  idle: 'var(--success)',
  done: 'var(--text-faint)',
  error: 'var(--error)',
};

// Card-kind body dispatch, keyed against CARD_KIND_COMMAND's own keys
// (conversation-blocks.ts) so the two tables enumerating CommandCard['kind']
// can't drift apart (interactive-commands §8). 'notice' is excluded — it
// isn't rendered as a card at all (see the early return below).
type CardKind = Exclude<keyof typeof CARD_KIND_COMMAND, 'notice'>;
type CardOfKind<K extends CardKind> = Extract<CommandCard, { kind: K }>;

const CARD_BODY: { [K in CardKind]: (card: CardOfKind<K>, sessionId: string) => JSX.Element } = {
  usage: (card) => <UsageBody card={card} />,
  context: (card) => <ContextBody card={card} />,
  model: (card, sessionId) => <ModelBody card={card} sessionId={sessionId} />,
  status: (card) => <StatusBody meta={card.meta} />,
  help: (card) => <HelpBody entries={card.entries} />,
  text: (card) => <PreBody text={card.text} />,
};

export default function CommandBlock({ b: block, sessionId }: { b: CommandConversationBlock; sessionId: string }) {
  const card = block.card;

  // Notice: NOT a card — glyph-column one-liner identical to tool blocks (§8).
  if (card?.kind === 'notice') {
    return (
      <div className="cmdcard-notice">
        <span className="cmdcard-notice-glyph">▦</span>
        <div className="cmdcard-notice-text">{card.text}</div>
      </div>
    );
  }

  const label = cardHeaderLabel(card, block.command); // falls back to 'OUTPUT' when both resolve empty

  return (
    <div className="cmdcard">
      {/* header: glyph + command name; loading adds the right-aligned pulse */}
      <div className="cmdcard-header">
        <span className="cmdcard-header-glyph">▦</span>
        <span className="cmdcard-header-label">{label}</span>
        {!card && (
          <>
            <span className="cmdcard-header-spacer" />
            <span className="cmdcard-loading">
              <span className="cmdcard-loading-dot" />
              <span className="cmdcard-loading-text">running…</span>
            </span>
          </>
        )}
      </div>

      {!card ? (
        <div className="cmdcard-fetching">fetching…</div>
      ) : (
        (CARD_BODY[card.kind] as (card: CommandCard, sessionId: string) => JSX.Element)(card, sessionId)
      )}
    </div>
  );
}

/** Label above, then bar (flex) + right-side text; reset text wraps under the bar on narrow panes. */
function MeterRow({ label, percent, right }: { label: string; percent: number; right: React.ReactNode }) {
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div className="cmdcard-meter-label">{label}</div>
      <div className="cmdcard-meter-row">
        <div className="cmdcard-meter-track">
          <div className="cmdcard-meter-fill" style={{ width: `${p}%`, background: meterFillColor(percent) }} />
        </div>
        {right}
      </div>
    </div>
  );
}

function UsageBody({ card }: { card: Extract<CommandCard, { kind: 'usage' }> }) {
  return (
    <>
      <div className="cmdcard-usage-list">
        {card.meters.map((m, i) => (
          <MeterRow
            key={i}
            label={m.label}
            percent={m.percentUsed}
            right={
              <>
                <span className="cmdcard-usage-percent">{m.percentUsed}%</span>
                <span className="cmdcard-usage-resets">resets {m.resetsAt}</span>
              </>
            }
          />
        ))}
      </div>
      {card.tail && <div className="cmdcard-usage-tail">{card.tail}</div>}
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
            <span className="cmdcard-context-right">
              <span className="cmdcard-context-used">{card.usedLabel}</span>
              <span className="cmdcard-context-limit">/{card.limitLabel}</span>
            </span>
          }
        />
      )}
      <PreBody text={card.body} top={card.percentUsed !== null ? 8 : 0} />
    </>
  );
}

function ModelBody({ card, sessionId }: { card: Extract<CommandCard, { kind: 'model' }>; sessionId: string }) {
  const live = useStore((s) => s.sessions.find((session) => session.id === sessionId));
  const currentId = liveCurrentModelId(live?.model.id, card.currentId); // FR-21: live, never the snapshot
  const disabled = live !== undefined && isTerminalStatus(live.status);
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
            onMouseEnter={interactive ? (e) => (e.currentTarget.style.background = 'var(--bg-raised)') : undefined}
            onMouseLeave={interactive ? (e) => (e.currentTarget.style.background = 'transparent') : undefined}
            className={
              'cmdcard-model-row' +
              (interactive ? ' cmdcard-model-row--interactive' : '') +
              (disabled && !isCurrent ? ' cmdcard-model-row--dim' : '')
            }
          >
            <span className={`cmdcard-model-glyph ${isCurrent ? 'cmdcard-model-glyph-current' : 'cmdcard-model-glyph-idle'}`}>
              {isCurrent ? '●' : '○'}
            </span>
            <span className={`cmdcard-model-label ${isCurrent ? 'cmdcard-model-label-current' : 'cmdcard-model-label-idle'}`}>
              {m.label}
            </span>
            {isCurrent && <span className="cmdcard-model-current-tag">current</span>}
          </div>
        );
      })}
      {error && <div className="cmdcard-model-error">{error}</div>}
    </div>
  );
}

function StatusBody({ meta }: { meta: SessionMeta }) {
  const rows: [string, React.ReactNode][] = [
    ['name', meta.name],
    ['cwd', <span className="cmdcard-status-cwd">{displayWslCwd(meta.cwd) ?? meta.cwd}</span>],
    ['model', meta.model.label],
    ['status', <span style={{ color: STATUS_COLOR[meta.status] }}>{meta.status}</span>],
    ['runtime', meta.runtime],
    ['permissions', meta.permissionMode],
    [
      'ctx',
      <span>
        <span className="cmdcard-status-ctx-used">{formatContextTokens(meta.contextUsedTokens)}</span>
        <span className="cmdcard-status-ctx-limit">/{formatContextTokens(meta.contextLimitTokens)}</span>
      </span>,
    ],
    ['started', new Date(meta.startedAt).toLocaleString()],
  ];
  return (
    <div className="cmdcard-status-grid">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span className="cmdcard-status-key">{k}</span>
          <span className="cmdcard-status-value">{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

function HelpBody({ entries }: { entries: HelpEntry[] }) {
  return (
    <div>
      <div className="cmdcard-help-grid">
        {entries.map((e) => (
          <Fragment key={e.command}>
            <span className="cmdcard-help-command">/{e.command}</span>
            <span className="cmdcard-help-description">{e.description}</span>
          </Fragment>
        ))}
      </div>
      <div className="cmdcard-help-footer">other /commands are passed to Claude Code</div>
    </div>
  );
}

/** Preformatted body (context/text cards): horizontal scroll inside the card only. */
function PreBody({ text, top = 0 }: { text: string; top?: number }) {
  return (
    <div className="scz cmdcard-pre" style={{ marginTop: top }}>
      {text}
    </div>
  );
}

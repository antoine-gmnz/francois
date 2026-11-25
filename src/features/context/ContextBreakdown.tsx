// token-viewer FR-15/FR-16 — the session panel Context tab's breakdown, after
// the Claude app's "Context" popover, in Graphite & Signal (spec §8):
//
//   CONTEXT              19% used · 191.5K / 1M   ← the figure forces a probe
//   ▬▬▬▬▬▬▬▬▬▬▬────────────────────────────────   one segment per in-window row + buffer
//   ■ Messages                      123.8K  12.4%
//   …                                              in-window rows, biggest first
//   ■ Autocompact buffer · Free space              the reserve
//   ■ MCP tools (deferred)          117.4K      —  out of the window, faint
//   ▸ MCP tools  239 · ▸ Memory files  1 · ▸ Custom agents  20
//   Updated just now · refreshes when this turn ends
//
// State (fetching, staleness, the hide/show decision) lives in the caller —
// ContextSection hides its own MeterRow whenever this renders a breakdown.

import { useState, type ReactNode } from 'react';
import type { SessionStatus } from '../../../contract/common';
import type { ContextBreakdown as Breakdown, ContextCategory } from '../../../contract/token-viewer';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { SidePanelLabel } from '../../ui/SidePanel';
import {
  barSegments,
  categoryKey,
  categoryTone,
  footerCopy,
  groupMcpTools,
  headerParts,
  isTurnLive,
  orderRows,
  pathLeaf,
  shareLabel,
  tokenLabel,
  toolLabel,
  type BreakdownView,
} from './context-breakdown';
import './context.css';

type ListId = 'mcp' | 'memory' | 'agents';

export interface ContextBreakdownProps {
  view: BreakdownView;
  status: SessionStatus;
  loading: boolean;
  onRefresh: () => void;
}

export function ContextBreakdown({ view, status, loading, onRefresh }: ContextBreakdownProps) {
  const now = useElapsedClock(view.kind === 'shown', 30_000);

  switch (view.kind) {
    case 'hidden':
      return null;
    case 'measuring':
      return (
        <section className="context-breakdown">
          <Head aside={<span className="context-breakdown__placeholder">Measuring context…</span>} />
        </section>
      );
    case 'pending':
      return (
        <section className="context-breakdown">
          <Head aside={<span className="context-breakdown__placeholder">Measured when this turn ends</span>} />
        </section>
      );
    case 'error':
      return (
        <section className="context-breakdown">
          <Head />
          <ErrorLine message={view.message} onRetry={onRefresh} />
        </section>
      );
    case 'shown': {
      const { breakdown, measuredAt } = view.response;
      const footer = footerCopy({ loading, measuredAt, now, turnLive: isTurnLive(status) });
      return (
        <section className="context-breakdown">
          <Header breakdown={breakdown} onRefresh={onRefresh} />
          <Body breakdown={breakdown} />
          {footer && <p className="context-breakdown__footer">{footer}</p>}
          {view.error && <ErrorLine message={view.error} onRetry={onRefresh} />}
        </section>
      );
    }
  }
}

/** The CONTEXT label; `aside` rides in its right-aligned count slot. */
function Head({ aside }: { aside?: ReactNode }) {
  return <SidePanelLabel count={aside}>Context</SidePanelLabel>;
}

function Header({ breakdown, onRefresh }: { breakdown: Breakdown; onRefresh: () => void }) {
  const { used, figure } = headerParts(breakdown);
  return (
    <Head
      aside={
        <span className="context-breakdown__summary">
          <span className="context-breakdown__used">{used}</span>
          <button type="button" className="context-breakdown__figure" title={`Measure again · ${breakdown.model}`} onClick={onRefresh}>
            {figure}
          </button>
        </span>
      }
    />
  );
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="context-breakdown__footer">
      {message}{' '}
      <button type="button" className="context-breakdown__retry" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

function Body({ breakdown }: { breakdown: Breakdown }) {
  const [open, setOpen] = useState<ReadonlySet<ListId>>(new Set());
  const toggle = (id: ListId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { used, reserve, deferred } = orderRows(breakdown.categories);
  const max = breakdown.maxTokens;

  return (
    <>
      <div className="context-breakdown__bar" role="img" aria-label={headerParts(breakdown).used}>
        {barSegments(breakdown).map((seg) => (
          // eslint-disable-next-line no-restricted-syntax -- segment width is runtime-computed from the breakdown
          <span key={seg.key} className={`context-breakdown__seg context-breakdown__swatch--${seg.tone}`} style={{ width: `${seg.percent}%` }} />
        ))}
      </div>
      <CategoryRows rows={used} max={max} />
      {reserve.length > 0 && <CategoryRows rows={reserve} max={max} spaced />}
      {deferred.length > 0 && <CategoryRows rows={deferred} max={max} spaced />}
      {(breakdown.mcpTools.length > 0 || breakdown.memoryFiles.length > 0 || breakdown.agents.length > 0) && (
        <div className="context-breakdown__lists">
          {breakdown.mcpTools.length > 0 && (
            <ExpandList label="MCP tools" count={breakdown.mcpTools.length} open={open.has('mcp')} onToggle={() => toggle('mcp')}>
              {groupMcpTools(breakdown.mcpTools).map((group) => (
                <div key={group.server} className="context-breakdown__group">
                  <Entry name={group.server} tokens={group.tokens} strong />
                  {group.tools.map((tool) => (
                    <Entry
                      key={tool.name}
                      name={toolLabel({ name: tool.name, serverName: group.server })}
                      title={tool.name}
                      note={tool.deferred ? 'deferred' : undefined}
                      tokens={tool.tokens}
                      faint={tool.deferred}
                      indent
                    />
                  ))}
                </div>
              ))}
            </ExpandList>
          )}
          {breakdown.memoryFiles.length > 0 && (
            <ExpandList label="Memory files" count={breakdown.memoryFiles.length} open={open.has('memory')} onToggle={() => toggle('memory')}>
              {breakdown.memoryFiles.map((file) => (
                <Entry key={file.path} name={pathLeaf(file.path)} title={file.path} note={file.type} tokens={file.tokens} />
              ))}
            </ExpandList>
          )}
          {breakdown.agents.length > 0 && (
            <ExpandList label="Custom agents" count={breakdown.agents.length} open={open.has('agents')} onToggle={() => toggle('agents')}>
              {breakdown.agents.map((agent) => (
                <Entry key={`${agent.source}:${agent.agentType}`} name={agent.agentType} title={agent.agentType} note={agent.source} tokens={agent.tokens} />
              ))}
            </ExpandList>
          )}
        </div>
      )}
    </>
  );
}

function CategoryRows({ rows, max, spaced }: { rows: ContextCategory[]; max: number; spaced?: boolean }) {
  return (
    <div className={spaced ? 'context-breakdown__rows context-breakdown__rows--spaced' : 'context-breakdown__rows'}>
      {rows.map((row) => {
        const tone = categoryTone(row);
        return (
          <div key={categoryKey(row)} className={`context-breakdown__row context-breakdown__row--${row.kind}`}>
            <span className={`context-breakdown__dot context-breakdown__swatch--${tone}`} aria-hidden />
            <span className="context-breakdown__name truncate" title={row.name}>
              {row.name}
            </span>
            <span className="context-breakdown__tokens">{tokenLabel(row.tokens)}</span>
            <span className="context-breakdown__share">{shareLabel(row, max)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ExpandList({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="context-breakdown__list">
      <button type="button" className="context-breakdown__toggle" aria-expanded={open} onClick={onToggle}>
        <span className="context-breakdown__caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="context-breakdown__name truncate">{label}</span>
        <span className="context-breakdown__count">{count}</span>
      </button>
      {open && <div className="context-breakdown__entries">{children}</div>}
    </div>
  );
}

function Entry({
  name,
  title,
  note,
  tokens,
  faint,
  strong,
  indent,
}: {
  name: string;
  title?: string;
  note?: string;
  tokens: number;
  faint?: boolean;
  strong?: boolean;
  indent?: boolean;
}) {
  const cls = ['context-breakdown__entry', faint && 'context-breakdown__entry--faint', strong && 'context-breakdown__entry--strong', indent && 'context-breakdown__entry--indent']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} title={title}>
      <span className="context-breakdown__entry-name truncate">{name}</span>
      {note && <span className="context-breakdown__note">{note}</span>}
      <span className="context-breakdown__tokens">{tokenLabel(tokens)}</span>
    </div>
  );
}

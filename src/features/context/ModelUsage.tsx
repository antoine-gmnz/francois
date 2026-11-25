// audit C2 — the Context tab's per-model usage: one row per model the thread
// ran on (cost + every token it processed), its counters on a faint line under
// it. Reuses the breakdown's row/entry classes (context.css); the copy and the
// ordering are model-usage.ts's.

import type { RuntimeMetrics } from '../../../contract/common';
import { SidePanelLabel } from '../../ui/SidePanel';
import { modelUsageView } from './model-usage';
import './context.css';

export function ModelUsage({ metrics }: { metrics: RuntimeMetrics | undefined }) {
  const view = modelUsageView(metrics);
  if (!view) return null;
  return (
    <section className="context-breakdown">
      <SidePanelLabel count={<span className="context-breakdown__summary">{view.total}</span>}>Models</SidePanelLabel>
      <div className="context-breakdown__rows">
        {view.rows.map((row) => (
          <div key={row.model}>
            <div className="context-breakdown__row" title={`${row.model} · ${row.tokens} tokens · ${row.cost}`}>
              <span className="context-breakdown__name truncate">{row.model}</span>
              <span className="context-breakdown__tokens">{row.tokens}</span>
              <span className="context-breakdown__share">{row.cost}</span>
            </div>
            <div className="context-breakdown__entry context-breakdown__entry--faint">
              <span className="context-breakdown__entry-name truncate">{row.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

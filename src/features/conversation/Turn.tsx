// design 9a — one turn of the SESSION transcript.
//
// Before this the transcript was a flat list: every block carried its own glyph
// in its own gutter, so a reply that wrote two files and ran the suite read as
// five unrelated lines. A turn is one glyph, one header stating who spoke and
// what the reply cost, and one content column holding the prose and the tool
// rail together — which is what makes a reply read as a single thing.
//
// The grouping and every derived string are pure (./transcript-turns); this
// file is DOM assembly only.

import { AssistantBody, SubagentBanner, ToolRail, UserBody } from './Block';
import {
  formatClock,
  turnMeta,
  turnStartedAt,
  type TranscriptTurn,
  type TurnBlock,
} from './transcript-turns';
import type { ToolConversationBlock } from '../../../contract/conversation-view';
import './conversation.css';

/** The gutter glyph — the who, carried by a mark rather than by a second label. */
const GUTTER = { user: '›', assistant: '⏺' } as const;
const WHO = { user: 'You', assistant: 'Francois' } as const;

export default function Turn({
  turn,
  model,
  now,
}: {
  turn: TranscriptTurn;
  /** The session's model, shown on a reply. Absent on an agent trail or before meta lands. */
  model?: string;
  /** Ticking clock, so a streaming reply's duration counts up. */
  now: number;
}) {
  const startedAt = turnStartedAt(turn);
  const meta = turnMeta(turn, now);
  // A prompt is stamped with the wall clock it was sent at; a reply with what it
  // cost. Same slot, because they answer the same question about the turn.
  const right = turn.role === 'user' ? (startedAt === null ? '' : formatClock(startedAt)) : meta;

  return (
    <div className={`turn turn--${turn.role}`}>
      <span className="turn__gutter">{GUTTER[turn.role]}</span>
      <div className="turn__col">
        <div className="turn__head">
          <span className="turn__who">{WHO[turn.role]}</span>
          {turn.role === 'assistant' && model !== undefined && model !== '' && (
            <span className="turn__model">{model}</span>
          )}
          {/* The rule spans whatever the labels leave — it is what makes the
              header a header rather than a line of text above the body. */}
          <span className="turn__rule" />
          {right !== '' && <span className="turn__meta">{right}</span>}
        </div>
        <div className="turn__body">{renderBody(turn.blocks)}</div>
      </div>
    </div>
  );
}

/**
 * Lay the turn's blocks out, collapsing each run of consecutive tool calls onto
 * one rail. Prose and dispatches break a run — they are what the run is being
 * indented UNDER, so folding them in would lose the ordering that makes a turn
 * readable as "said this, did that, then said this".
 */
function renderBody(blocks: TurnBlock[]) {
  const out: React.ReactNode[] = [];
  let run: ToolConversationBlock[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(<ToolRail key={`rail:${run[0]!.blockId}`} blocks={run} />);
    run = [];
  };
  for (const b of blocks) {
    if (b.kind === 'tool') {
      run.push(b);
      continue;
    }
    flush();
    if (b.kind === 'user') out.push(<UserBody key={b.blockId} b={b} />);
    else if (b.kind === 'assistant') out.push(<AssistantBody key={b.blockId} b={b} />);
    else out.push(<SubagentBanner key={b.blockId} b={b} />);
  }
  flush();
  return out;
}

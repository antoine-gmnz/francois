// One rendered ConversationBlock (conversation-view §8). Extracted verbatim from
// ConversationView so the agent-tab body renders a subagent's transcript with the
// SAME vocabulary — glyphs, colors, markdown, tool-card layout — instead of
// growing a second renderer that would drift from this one.
//
// design 9a: the SESSION transcript no longer renders through `Block` — it
// groups blocks into turns (Turn.tsx) and draws its own gutter and header. The
// per-block BODIES are exported from here and shared by both, so a turn and an
// agent trail keep saying the same thing the same way; only the container
// around them differs.

import { memo } from 'react';
import { toolBody, type ConversationBlock, type SubagentConversationBlock, type ToolConversationBlock, type UserConversationBlock } from '../../../contract/conversation-view';
import type { AssistantConversationBlock } from '../../../contract/conversation-view';
import CommandBlock from '../commands/CommandCard';
import { toneVar } from '../../lib/tone';
import Markdown from './MarkdownView';
import PermissionCard from '../permissions/PermissionCard';
import QuestionCard from '../questions/QuestionCard';
import { StatusDot } from '../../ui/StatusDot';
import { toolResultChips } from './transcript-turns';
import './conversation.css';

// transcript-perf FR-2: every prop these receive is referentially stable
// across a render that does not change it (Turn.tsx's `turn`/Turn items come
// from a useMemo keyed on state.blocks), so the default shallow React.memo
// comparison is enough to bail a render that has nothing new to draw.

function BlockImpl({ b: block, sessionId }: { b: ConversationBlock; sessionId: string }) {
  // interactive-commands: command cards (and notice one-liners) have their own renderer (§8)
  if (block.kind === 'command') {
    return <CommandBlock b={block} sessionId={sessionId} />;
  }
  // session-questions: interactive question cards (spec §8)
  if (block.kind === 'question') {
    return <QuestionCard b={block} sessionId={sessionId} />;
  }
  // permission-guardrails: approval cards for gated tool calls (spec §8)
  if (block.kind === 'permission') {
    return <PermissionCard b={block} sessionId={sessionId} />;
  }
  if (block.kind === 'user') {
    // design 7a: the prompt is an accent `›` line in the terminal's own type,
    // not a bordered card. The glyph carries the who — a "YOU" label above a
    // card was the sans-era way of saying the same thing twice.
    return (
      <div className="block-row block-user">
        <span className="block-glyph block-user__arrow">›</span>
        <div className="block-content">
          <UserBody b={block} />
        </div>
      </div>
    );
  }

  // Assistant replies arrive as Markdown source — render it formatted (own
  // container, so the shared pre-wrap wrapper below never touches it). The
  // streaming caret trails the rendered content. The body tone rides a class,
  // not a color: the contract's literal is a dark-palette hex, and an inline
  // color would beat every light-theme rule (see lib/tone.ts).
  if (block.kind === 'assistant') {
    return (
      <div className="block-row">
        <span className="block-glyph" style={{ color: toneVar(block.glyphColor) }}>
          {block.glyph}
        </span>
        <div className="block-content">
          <AssistantBody b={block} />
        </div>
      </div>
    );
  }

  if (block.kind === 'subagent') {
    return <SubagentBanner b={block} />;
  }

  // design 9a: a lone tool call is a bare row — the same object a session turn
  // renders, without the rail. An agent trail is a flat list, so a rail per
  // block would draw a 1px stub beside every row and join nothing.
  return <ToolRow b={block} />;
}

const Block = memo(BlockImpl);
export default Block;

// ---------- shared bodies (design 9a: one vocabulary, two containers) ----------

function UserBodyImpl({ b }: { b: UserConversationBlock }) {
  // transcript-perf FR-21: the `.block-user__queued` badge is gone — a queued
  // prompt no longer becomes a transcript block at all (see ./pending-queue
  // and the composer's own pending strip), so `queued` is no longer a field
  // this body could read.
  return <div className="block-user__body">{b.text}</div>;
}
export const UserBody = memo(UserBodyImpl);

function AssistantBodyImpl({ b }: { b: AssistantConversationBlock }) {
  return (
    <>
      <Markdown text={b.text} streaming={b.isStreaming} />
      {b.isStreaming && <span className="block-caret" />}
    </>
  );
}
export const AssistantBody = memo(AssistantBodyImpl);

/**
 * design-refresh FR-7: dispatch renders as a purple-tinted banner, not a bare
 * glyph row — bold agent name, soft bg from --hue-purple. It stays a banner
 * rather than a rail row under 9a: a dispatch hands the work to someone else,
 * which is a different kind of event from a tool the reply ran itself.
 */
function SubagentBannerImpl({ b }: { b: SubagentConversationBlock }) {
  return (
    <div className="block-subagent">
      <span className="block-glyph" style={{ color: toneVar(b.glyphColor) }}>
        {b.glyph}
      </span>
      <div className="block-content block-body" style={{ color: toneVar(b.bodyColor) }}>
        Dispatched subagent <span className="block-subagent__name">{b.agentName}</span>
        {/* The model the dispatch named — shown only when it differs from the
            session default, i.e. only when the dispatch named one at all. */}
        {b.agentModel && <span className="block-subagent__model">{b.agentModel}</span>}
        {b.meta && <span className="block-meta"> · {b.meta}</span>}
      </div>
    </div>
  );
}
export const SubagentBanner = memo(SubagentBannerImpl);

/**
 * design 9a: one tool call, as a four-column row — glyph · tool name · target ·
 * result. The result stopped being a ` · 14 failed` tail on the end of a
 * sentence and became chips at the right edge, so a column of calls can be
 * scanned for the one that went wrong without reading any of them.
 */
function ToolRowImpl({ b }: { b: ToolConversationBlock }) {
  const chips = toolResultChips(b.meta);
  return (
    <div className={'toolrow' + (b.isStreaming ? ' toolrow--live' : '')}>
      <span className="toolrow__glyph" style={{ color: toneVar(b.glyphColor) }}>
        {b.glyph}
      </span>
      <span className="toolrow__name">{b.tool}</span>
      {/* The full call stays reachable on hover — the target column truncates,
          and a truncated path is exactly when you want the whole one. */}
      <span className="toolrow__target" title={toolBody(b.tool, b.summary)}>
        {b.summary}
      </span>
      <span className="toolrow__chips">
        {b.isStreaming && chips.length === 0 ? (
          <StatusDot color="var(--accent)" size={5} pulsing />
        ) : (
          chips.map((c) => (
            <span key={`${c.tone}:${c.text}`} className={`toolrow__chip toolrow__chip--${c.tone}`}>
              {c.text}
            </span>
          ))
        )}
      </span>
    </div>
  );
}
export const ToolRow = memo(ToolRowImpl);

/**
 * design 9a: a run of consecutive tool calls hangs off a single vertical rail
 * inside the turn's content column. The rail replaces 7a's hairline-divided
 * card — under the flat treatment a card would be a second surface floating in
 * the turn, where the rail reads as "this is what that paragraph did".
 */
function ToolRailImpl({ blocks }: { blocks: ToolConversationBlock[] }) {
  return (
    <div className="toolrail">
      {blocks.map((b) => (
        <ToolRow key={b.blockId} b={b} />
      ))}
    </div>
  );
}
export const ToolRail = memo(ToolRailImpl);

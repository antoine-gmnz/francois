// One rendered ConversationBlock (conversation-view §8). Extracted verbatim from
// ConversationView so the agent-tab body renders a subagent's transcript with the
// SAME vocabulary — glyphs, colors, markdown, tool-card layout — instead of
// growing a second renderer that would drift from this one.

import { toolBody, type ConversationBlock, type ToolConversationBlock } from '../../../contract/conversation-view';
import CommandBlock from '../commands/CommandCard';
import { toneVar } from '../../lib/tone';
import Markdown from './MarkdownView';
import PermissionCard from '../permissions/PermissionCard';
import QuestionCard from '../questions/QuestionCard';
import { StatusDot } from '../../ui/StatusDot';
import './conversation.css';

export default function Block({ b: block, sessionId }: { b: ConversationBlock; sessionId: string }) {
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
    return (
      <div className="block-user">
        <div className="block-user__header">
          <span className="block-user__label">YOU</span>
          <span className="block-user__spacer" />
          {block.queued && (
            <span className="block-user__queued">
              <StatusDot color="var(--warn)" size={5} pulsing />
              <span className="block-user__queued-label">queued</span>
            </span>
          )}
        </div>
        <div className="block-user__body">{block.text}</div>
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
          <Markdown text={block.text} streaming={block.isStreaming} />
          {block.isStreaming && <span className="block-caret" />}
        </div>
      </div>
    );
  }

  if (block.kind === 'subagent') {
    // design-refresh FR-7: dispatch renders as a purple-tinted banner, not a
    // bare glyph row — bold agent name, soft bg/border from --hue-purple.
    return (
      <div className="block-subagent">
        <span className="block-glyph" style={{ color: toneVar(block.glyphColor) }}>
          {block.glyph}
        </span>
        <div className="block-content block-body" style={{ color: toneVar(block.bodyColor) }}>
          Dispatched subagent <span className="block-subagent__name">{block.agentName}</span>
          {/* The model the dispatch named — shown only when it differs from the
              session default, i.e. only when the dispatch named one at all. */}
          {block.agentModel && <span className="block-subagent__model">{block.agentModel}</span>}
          {block.meta && <span className="block-meta"> · {block.meta}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="block-row">
      <span className="block-glyph" style={{ color: toneVar(block.glyphColor) }}>
        {block.glyph}
      </span>
      <div className="block-content block-body" style={{ color: toneVar(block.bodyColor) }}>
        {toolBody(block.tool, block.summary)}
        {block.meta && <span className="block-meta"> · {block.meta}</span>}
      </div>
    </div>
  );
}

/**
 * design-refresh FR-7: a run of consecutive tool blocks (grouped by
 * conversation-blocks.ts's `groupToolRuns`) renders as ONE hairline-divided
 * card instead of N loose rows — same glyph/body vocabulary as a bare
 * `.block-row`, just wrapped and separated by `.tool-group-row` + a `--border-2`
 * top rule on every row after the first.
 */
export function ToolGroup({ blocks }: { blocks: ToolConversationBlock[] }) {
  return (
    <div className="tool-group">
      {blocks.map((block) => (
        <div key={block.blockId} className="tool-group-row">
          <span className="block-glyph" style={{ color: toneVar(block.glyphColor) }}>
            {block.glyph}
          </span>
          <div className="block-content block-body" style={{ color: toneVar(block.bodyColor) }}>
            {toolBody(block.tool, block.summary)}
            {block.meta && <span className="block-meta"> · {block.meta}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// One rendered ConversationBlock (conversation-view §8). Extracted verbatim from
// ConversationView so the agent-tab body renders a subagent's transcript with the
// SAME vocabulary — glyphs, colors, markdown, tool-card layout — instead of
// growing a second renderer that would drift from this one.

import { toolBody, type ConversationBlock } from '../../../contract/conversation-view';
import CommandBlock from '../commands/CommandCard';
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
  // streaming caret trails the rendered content.
  if (block.kind === 'assistant') {
    return (
      <div className="block-row">
        <span className="block-glyph" style={{ color: block.glyphColor }}>
          {block.glyph}
        </span>
        <div className="block-content">
          <Markdown text={block.text} color={block.bodyColor} />
          {block.isStreaming && <span className="block-caret" />}
        </div>
      </div>
    );
  }

  let glyph = '';
  let glyphColor = 'var(--text-dim)';
  let bodyColor = 'var(--text)';
  let body: React.ReactNode = '';
  if (block.kind === 'tool') {
    glyph = block.glyph;
    glyphColor = block.glyphColor;
    bodyColor = block.bodyColor;
    body = (
      <>
        {toolBody(block.tool, block.summary)}
        {block.meta && <span className="block-meta"> · {block.meta}</span>}
      </>
    );
  } else {
    glyph = block.glyph;
    glyphColor = block.glyphColor;
    bodyColor = block.bodyColor;
    body = (
      <>
        Dispatched subagent  {block.agentName}
        {block.meta && <span className="block-meta"> · {block.meta}</span>}
      </>
    );
  }

  return (
    <div className="block-row">
      <span className="block-glyph" style={{ color: glyphColor }}>
        {glyph}
      </span>
      <div className="block-content block-body" style={{ color: bodyColor }}>
        {body}
      </div>
    </div>
  );
}

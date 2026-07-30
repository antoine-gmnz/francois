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

export default function Block({ b, sessionId }: { b: ConversationBlock; sessionId: string }) {
  // interactive-commands: command cards (and notice one-liners) have their own renderer (§8)
  if (b.kind === 'command') {
    return <CommandBlock b={b} sessionId={sessionId} />;
  }
  // session-questions: interactive question cards (spec §8)
  if (b.kind === 'question') {
    return <QuestionCard b={b} sessionId={sessionId} />;
  }
  // permission-guardrails: approval cards for gated tool calls (spec §8)
  if (b.kind === 'permission') {
    return <PermissionCard b={b} sessionId={sessionId} />;
  }
  if (b.kind === 'user') {
    return (
      <div className="block-user">
        <div className="block-user__header">
          <span className="block-user__label">YOU</span>
          <span className="block-user__spacer" />
          {b.queued && (
            <span className="block-user__queued">
              <StatusDot color="var(--warn)" size={5} pulsing />
              <span className="block-user__queued-label">queued</span>
            </span>
          )}
        </div>
        <div className="block-user__body">{b.text}</div>
      </div>
    );
  }

  // Assistant replies arrive as Markdown source — render it formatted (own
  // container, so the shared pre-wrap wrapper below never touches it). The
  // streaming caret trails the rendered content.
  if (b.kind === 'assistant') {
    return (
      <div className="block-row">
        <span className="block-glyph" style={{ color: b.glyphColor }}>
          {b.glyph}
        </span>
        <div className="block-content">
          <Markdown text={b.text} color={b.bodyColor} />
          {b.isStreaming && <span className="block-caret" />}
        </div>
      </div>
    );
  }

  let glyph = '';
  let glyphColor = 'var(--text-dim)';
  let bodyColor = 'var(--text)';
  let body: React.ReactNode = '';
  if (b.kind === 'tool') {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        {toolBody(b.tool, b.summary)}
        {b.meta && <span className="block-meta"> · {b.meta}</span>}
      </>
    );
  } else {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        Dispatched subagent  {b.agentName}
        {b.meta && <span className="block-meta"> · {b.meta}</span>}
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

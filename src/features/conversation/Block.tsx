// One rendered ConversationBlock (conversation-view §8). Extracted verbatim from
// ConversationView so the agent-tab body renders a subagent's transcript with the
// SAME vocabulary — glyphs, colors, markdown, tool-card layout — instead of
// growing a second renderer that would drift from this one.

import { toolBody, type ConversationBlock } from '../../../contract/conversation-view';
import CommandBlock from '../commands/CommandCard';
import Markdown from './MarkdownView';
import PermissionCard from '../permissions/PermissionCard';
import PluginInjectionCard from '../plugins/PluginInjectionCard';
import { pluginAttributionLine } from '../plugins/plugins';
import QuestionCard from '../questions/QuestionCard';

const C = {
  accent: 'var(--accent)',
  faint: 'var(--text-faint)',
  dim: 'var(--text-dim)',
  primary: 'var(--text)',
  userBody: 'var(--text-strong)',
  queued: 'var(--warn)',
};

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
  // plugin-system FR-53: a plugin's prompt, parked behind Approve/Deny. Nothing
  // has been sent — this card is the only thing that can send it.
  if (b.kind === 'pluginInjection') {
    return <PluginInjectionCard b={b} sessionId={sessionId} />;
  }
  if (b.kind === 'user') {
    return (
      <div style={{ background: 'var(--bg-elevated)', borderLeft: '2px solid var(--accent)', borderRadius: '0 4px 4px 0', padding: '10px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 10, letterSpacing: '0.12em', color: C.accent }}>YOU</span>
          <span style={{ flex: 1 }} />
          {b.queued && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{ width: 5, height: 5, borderRadius: '50%', background: C.queued, animation: 'pulse 1.4s ease-in-out infinite' }}
              />
              <span style={{ fontSize: 9.5, letterSpacing: '0.04em', color: C.queued }}>queued</span>
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.userBody, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{b.text}</div>
        {/* plugin-system FR-58: a message the human approved but did not write.
            Persisted with the transcript, so it survives a reload and a resume —
            it is a record of what happened, not view state. */}
        {b.origin && (
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-faint)',
              marginTop: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {pluginAttributionLine(b.origin)}
          </div>
        )}
      </div>
    );
  }

  // Assistant replies arrive as Markdown source — render it formatted (own
  // container, so the shared pre-wrap wrapper below never touches it). The
  // streaming caret trails the rendered content.
  if (b.kind === 'assistant') {
    return (
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ width: 16, flexShrink: 0, textAlign: 'center', fontSize: 12, color: b.glyphColor, marginTop: 1 }}>{b.glyph}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Markdown text={b.text} color={b.bodyColor} />
          {b.isStreaming && (
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 15,
                background: C.accent,
                verticalAlign: 'text-bottom',
                marginLeft: 2,
                animation: 'blink 1s step-end infinite',
              }}
            />
          )}
        </div>
      </div>
    );
  }

  let glyph = '';
  let glyphColor = C.dim;
  let bodyColor = C.primary;
  let body: React.ReactNode = '';
  if (b.kind === 'tool') {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        {toolBody(b.tool, b.summary)}
        {b.meta && <span style={{ color: C.faint }}> · {b.meta}</span>}
      </>
    );
  } else {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        Dispatched subagent  {b.agentName}
        {b.meta && <span style={{ color: C.faint }}> · {b.meta}</span>}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 16, flexShrink: 0, textAlign: 'center', fontSize: 12, color: glyphColor, marginTop: 1 }}>{glyph}</span>
      <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, lineHeight: 1.55, color: bodyColor, whiteSpace: 'pre-wrap' }}>{body}</div>
    </div>
  );
}

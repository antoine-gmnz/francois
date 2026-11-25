// thinking-blocks (IMPROVEMENTS C1): the model's extended thinking, as a
// collapsed disclosure inside the reply it precedes. Collapsed by default —
// a thought is context for the answer, not the answer — and opened with a
// real <button> so click, Enter and Space all work and the state is announced.
// While the block is still streaming the core has not sent its text yet, so
// the row is a plain in-progress line with nothing to open.

import { memo, useState } from 'react';
import type { ThinkingConversationBlock } from '../../../contract/conversation-view';
import { Caret } from '../../ui/Loaders';
import { thinkingExpandable, thinkingLabel } from './thinking-blocks';
import './conversation.css';

function ThinkingBodyImpl({ b }: { b: ThinkingConversationBlock }) {
  const [open, setOpen] = useState(false);
  const label = thinkingLabel(b);
  if (!thinkingExpandable(b)) {
    return (
      <div className={'thinking' + (b.isStreaming ? ' thinking--live' : '')}>
        <span className="thinking__label">{label}</span>
        {b.isStreaming && <Caret />}
      </div>
    );
  }
  const bodyId = `thinking-${b.blockId}`;
  return (
    <div className={'thinking' + (open ? ' thinking--open' : '')}>
      <button
        type="button"
        className="thinking__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="thinking__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="thinking__label">{label}</span>
      </button>
      {open && (
        <div id={bodyId} className="thinking__body">
          {b.text}
        </div>
      )}
    </div>
  );
}

export const ThinkingBody = memo(ThinkingBodyImpl);

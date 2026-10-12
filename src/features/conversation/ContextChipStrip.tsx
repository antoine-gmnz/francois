// code-editor-agents FR-6 / FR-7 (design brief "Composer context-chip strip") — the
// chips the Code tab handed this session, above the composer input. A chip reads
// `path:start–end`; a click expands it (snippet read-only, note editable); `×`
// removes it. They are sent with the next message only (ComposerPane.send).

import { useState } from 'react';
import { MessageSquare, TextSelect, Undo2, X } from 'lucide-react';
import type { ContextChip } from '../../../contract/code-editor-agents';
import { CONTEXT_CHIPS_PER_SESSION } from '../../../contract/code-editor-agents';
import { CHIP_LIMIT_MESSAGE, chipLabel, cutNote, removeChip, updateChipNote, useContextChips } from '../../lib/context-chips';
import './context-chips.css';

const KIND_ICON = { selection: TextSelect, comment: MessageSquare, revert: Undo2 } as const;
const KIND_LABEL = { selection: 'selection', comment: 'comment', revert: 'revert' } as const;

function ChipCard({ sessionId, chip }: { sessionId: string; chip: ContextChip }): JSX.Element {
  const cut = cutNote(chip);
  return (
    <div className="ctx-chip-card">
      {chip.snippet !== undefined && (
        <>
          <pre className="ctx-chip-card__snippet">{chip.snippet}</pre>
          {cut && <span className="ctx-chip-card__cut">{cut}</span>}
        </>
      )}
      <textarea
        className="ctx-chip-card__note"
        rows={2}
        placeholder="Add a note…"
        aria-label="Note"
        value={chip.note ?? ''}
        onChange={(e) => updateChipNote(sessionId, chip.id, e.target.value)}
      />
    </div>
  );
}

export default function ContextChipStrip({ sessionId, cwd, inert }: { sessionId: string; cwd: string; inert: boolean }): JSX.Element | null {
  const chips = useContextChips(sessionId);
  const [openId, setOpenId] = useState<string | null>(null);
  if (chips.length === 0) return null;
  const open = chips.find((c) => c.id === openId) ?? null;
  return (
    <div className="ctx-chips">
      <div className="ctx-chips__row">
        {chips.map((c) => {
          const KindIcon = KIND_ICON[c.kind];
          const label = chipLabel(c, cwd);
          const on = c.id === openId;
          return (
            <span key={c.id} className={on ? 'ctx-chip ctx-chip--open' : 'ctx-chip'} title={c.note ? `${label}\n${c.note}` : label}>
              <button
                type="button"
                className="ctx-chip__body"
                aria-expanded={on}
                aria-label={`${KIND_LABEL[c.kind]} ${label}`}
                disabled={inert}
                onClick={() => setOpenId(on ? null : c.id)}
              >
                <KindIcon size={12} className="ctx-chip__icon" aria-hidden />
                <span className="ctx-chip__label">{label}</span>
              </button>
              {!inert && (
                <button type="button" className="ctx-chip__remove" aria-label={`Remove ${label}`} onClick={() => removeChip(sessionId, c.id)}>
                  <X size={12} aria-hidden />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {open && !inert && <ChipCard sessionId={sessionId} chip={open} />}
      <span className="ctx-chips__count">
        {chips.length === 1 ? '1 item will be sent with your message' : `${chips.length} items will be sent with your message`}
        {chips.length >= CONTEXT_CHIPS_PER_SESSION && <span className="ctx-chips__limit"> · {CHIP_LIMIT_MESSAGE}</span>}
      </span>
    </div>
  );
}

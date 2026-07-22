// session-questions — question card renderer for the SESSION transcript
// (spec §8 design brief). Inherits the command-card visual language; the
// classes live in src/styles.css and contain NO @keyframes/animation/transition
// (§8 motion rule — state changes are instant swaps). All submit/selection
// logic is pure in ./question-card (unit-tested); this file is DOM assembly +
// card-local UI state (picks, free-text drafts, hover, in-flight flag).

import { useRef, useState } from 'react';
import type { SessionQuestion } from '../contract/common';
import type { QuestionConversationBlock } from '../contract/session-questions';
import { sessionAnswerQuestion } from './api';
import {
  allComplete,
  answeredSelection,
  buildAnswers,
  commitFreeText,
  hasMultiSelect,
  initSelections,
  pickOption,
  shouldAutoSubmit,
  submitAnswers,
  type SectionSelection,
} from './question-card';

export default function QuestionCard({ b, sessionId }: { b: QuestionConversationBlock; sessionId: string }) {
  const [sel, setSel] = useState<SectionSelection[]>(() => initSelections(b.questions));
  const [inFlight, setInFlight] = useState(false);
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [hovered, setHovered] = useState<Record<number, string | null>>({});

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const resolvedRef = useRef(b.state !== 'pending');
  resolvedRef.current = b.state !== 'pending';

  const interactive = b.state === 'pending' && !inFlight;

  const submit = (answers: Record<string, string>) =>
    submitAnswers({
      answers,
      answer: (ans) => sessionAnswerQuestion(sessionId, b.blockId, ans),
      setInFlight,
      isResolved: () => resolvedRef.current,
      log: (m) => console.error(m),
    });

  // FR-18: apply a selection change; on a pure single-select card the change
  // that completes the last section submits immediately.
  const applySel = (next: SectionSelection[]) => {
    setSel(next);
    if (shouldAutoSubmit(b.questions, next)) void submit(buildAnswers(b.questions, next));
  };

  const onPick = (i: number, label: string) => {
    if (!interactive) return;
    applySel(pickOption(b.questions, sel, i, label));
  };

  const onCommitOther = (i: number) => {
    if (!interactive) return;
    const text = drafts[i] ?? '';
    if (text.trim() === '') return;
    setOtherOpen((o) => ({ ...o, [i]: false }));
    applySel(commitFreeText(b.questions, sel, i, text));
  };

  const cardClass =
    'qcard' +
    (b.state === 'pending' ? ' qcard-pending' : '') +
    (b.state === 'cancelled' ? ' qcard-cancelled' : '') +
    (b.state === 'pending' && inFlight ? ' qcard-inflight' : '');

  const showSubmit = hasMultiSelect(b.questions) && b.state === 'pending'; // §8.6: never for pure single-select
  const submitEnabled = allComplete(sel);

  return (
    <div className={cardClass}>
      <div className="qcard-head">
        <span className="qcard-label">QUESTION</span>
        {b.questions.map((q, i) => (
          <span key={i} className="qcard-chip">
            {q.header}
          </span>
        ))}
        {b.state === 'cancelled' && <span className="qcard-cancelled-note">— cancelled</span>}
      </div>

      {b.questions.map((q, i) => (
        <Section
          key={i}
          q={q}
          idx={i}
          block={b}
          sel={sel[i] ?? { selected: [], freeText: '' }}
          interactive={interactive}
          otherOpen={otherOpen[i] === true}
          draft={drafts[i] ?? ''}
          hovered={hovered[i] ?? null}
          onPick={onPick}
          onHover={(label) => setHovered((h) => ({ ...h, [i]: label }))}
          onOpenOther={() => {
            if (!interactive) return;
            setDrafts((d) => ({ ...d, [i]: sel[i]?.freeText ?? '' }));
            setOtherOpen((o) => ({ ...o, [i]: true }));
          }}
          onDraft={(text) => setDrafts((d) => ({ ...d, [i]: text }))}
          onCommit={() => onCommitOther(i)}
          onDismiss={() => {
            // §3 flow 4: Escape empties and collapses the row
            setDrafts((d) => ({ ...d, [i]: '' }));
            setOtherOpen((o) => ({ ...o, [i]: false }));
          }}
        />
      ))}

      {showSubmit && (
        <div className="qcard-submit">
          <span
            className={'qsubmit' + (submitEnabled ? '' : ' qsubmit-disabled')}
            onClick={() => {
              if (!interactive || !submitEnabled) return;
              void submit(buildAnswers(b.questions, sel));
            }}
          >
            answer ↵
          </span>
        </div>
      )}
    </div>
  );
}

function Section({
  q,
  idx,
  block,
  sel,
  interactive,
  otherOpen,
  draft,
  hovered,
  onPick,
  onHover,
  onOpenOther,
  onDraft,
  onCommit,
  onDismiss,
}: {
  q: SessionQuestion;
  idx: number;
  block: QuestionConversationBlock;
  sel: SectionSelection;
  interactive: boolean;
  otherOpen: boolean;
  draft: string;
  hovered: string | null;
  onPick: (i: number, label: string) => void;
  onHover: (label: string | null) => void;
  onOpenOther: () => void;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onDismiss: () => void;
}) {
  const answered = block.state === 'answered';
  // FR-19: pending renders from card-local picks; a resolved card reconstructs
  // its chosen rows from the persisted answer string (survives hydration).
  const recorded = answered ? answeredSelection(q, block.answers?.[q.question]) : null;
  const chosen = recorded ? recorded.chosen : sel.selected;
  const freeText = recorded ? recorded.freeText : sel.freeText.trim() !== '' ? sel.freeText : null;

  // FR-17: preview of the hovered-or-selected option beneath the section.
  let preview: string | null = null;
  if (interactive && hovered) {
    preview = q.options.find((o) => o.label === hovered)?.preview ?? null;
  }
  if (preview === null) {
    preview = q.options.find((o) => chosen.includes(o.label) && o.preview)?.preview ?? null;
  }

  const rowClass = (isChosen: boolean) =>
    'qopt' +
    (interactive ? ' qopt-interactive' : '') +
    (answered && !isChosen ? ' qopt-unchosen' : ''); // FR-19: unchosen rows dim

  return (
    <div className="qcard-section">
      <div className="qcard-q">{q.question}</div>

      {q.options.map((o) => {
        const isChosen = chosen.includes(o.label);
        return (
          <div
            key={o.label}
            className={rowClass(isChosen)}
            onClick={() => onPick(idx, o.label)}
            onMouseEnter={interactive ? () => onHover(o.label) : undefined}
            onMouseLeave={interactive ? () => onHover(null) : undefined}
          >
            <span className={'qopt-glyph' + (isChosen ? ' qopt-glyph-on' : '')}>
              {q.multiSelect ? (isChosen ? '☑' : '☐') : isChosen ? '▸' : ''}
            </span>
            <span className={'qopt-label' + (isChosen ? ' qopt-label-on' : '')}>{o.label}</span>
            <span className="qopt-desc">{o.description}</span>
          </div>
        );
      })}

      {/* other… free-text row (§8.4; echoes the free-text answer when chosen — FR-19) */}
      {otherOpen && interactive ? (
        <div className="qopt">
          <span className="qopt-glyph" />
          <input
            className="qother-input"
            value={draft}
            autoFocus
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onDismiss();
              }
            }}
          />
        </div>
      ) : freeText !== null ? (
        <div className={rowClass(true)} onClick={onOpenOther}>
          <span className="qopt-glyph qopt-glyph-on">{q.multiSelect ? '☑' : '▸'}</span>
          <span className="qopt-label qopt-label-on">{freeText}</span>
        </div>
      ) : (
        <div className={rowClass(false)} onClick={onOpenOther}>
          <span className="qopt-glyph" />
          <span className="qother">other…</span>
        </div>
      )}

      {preview !== null && <div className="scz qprev">{preview}</div>}
    </div>
  );
}

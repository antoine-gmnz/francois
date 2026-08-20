// session-questions — question card renderer for the SESSION transcript
// (spec §8 design brief, redrawn to design turn 13c "keep the table, fix the
// table"). All submit/selection logic is pure in ./question-card
// (unit-tested); this file is DOM assembly + card-local UI state (picks,
// free-text drafts, hover, in-flight flag). Styling lives in ./questions.css.

import { useRef, useState } from 'react';
import type { QuestionOption, SessionQuestion } from '../../../contract/common';
import type { QuestionConversationBlock } from '../../../contract/session-questions';
import { InlineMarkdown } from '../conversation/MarkdownView';
import { sessionAnswerQuestion } from '../../lib/api';
import {
  acceptRecommended,
  allComplete,
  answeredCount,
  answeredSelection,
  buildAnswers,
  commitFreeText,
  currentSection,
  displayLabel,
  hasMultiSelect,
  initSelections,
  isRecommended,
  pickOption,
  recommendedCount,
  sectionOrdinal,
  shouldAutoSubmit,
  submitAnswers,
  type SectionSelection,
} from './question-card';
import './questions.css';

export default function QuestionCard({
  b: block,
  sessionId,
}: {
  b: QuestionConversationBlock;
  sessionId: string;
}) {
  const [sel, setSel] = useState<SectionSelection[]>(() => initSelections(block.questions));
  const [inFlight, setInFlight] = useState(false);
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [hovered, setHovered] = useState<Record<number, string | null>>({});

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const resolvedRef = useRef(block.state !== 'pending');
  resolvedRef.current = block.state !== 'pending';

  const interactive = block.state === 'pending' && !inFlight;

  const submit = (answers: Record<string, string>) =>
    submitAnswers({
      answers,
      answer: (ans) => sessionAnswerQuestion(sessionId, block.blockId, ans),
      setInFlight,
      isResolved: () => resolvedRef.current,
      log: (m) => console.error(m),
    });

  // FR-18: apply a selection change; on a pure single-select card the change
  // that completes the last section submits immediately.
  const applySel = (next: SectionSelection[]) => {
    setSel(next);
    if (shouldAutoSubmit(block.questions, next)) void submit(buildAnswers(block.questions, next));
  };

  const onPick = (i: number, label: string) => {
    if (!interactive) return;
    applySel(pickOption(block.questions, sel, i, label));
  };

  const onCommitOther = (i: number) => {
    if (!interactive) return;
    const text = drafts[i] ?? '';
    if (text.trim() === '') return;
    setOtherOpen((o) => ({ ...o, [i]: false }));
    applySel(commitFreeText(block.questions, sel, i, text));
  };

  const cardClass =
    'qcard' +
    (block.state === 'pending' ? ' qcard--pending' : '') +
    (block.state === 'cancelled' ? ' qcard--cancelled' : '') +
    (block.state === 'pending' && inFlight ? ' qcard--inflight' : '');

  const showSubmit = hasMultiSelect(block.questions) && block.state === 'pending'; // §8.6: never for pure single-select
  const submitEnabled = allComplete(sel);
  const total = block.questions.length;
  const done = answeredCount(sel);
  // 13c: the ordinal of the section the block is waiting on. Only a live card
  // has a "where you are" — a resolved one is a record, not a form.
  const current = block.state === 'pending' ? currentSection(sel) : -1;
  const recCount = recommendedCount(block.questions);

  const onAcceptAll = () => {
    if (!interactive) return;
    applySel(acceptRecommended(block.questions, sel));
  };

  return (
    <div className={cardClass}>
      {/* 13c: the header states the shape of the block (how many, how far in)
          and carries the one-click "take my picks". It replaces the old row of
          chips, which repeated each question's own header text a line above the
          question itself. */}
      <div className="qcard__head">
        <span className="qcard__label">QUESTION</span>
        <span className="qcard__count">
          {block.state === 'pending' ? `${total} · ${done} answered` : null}
          {block.state === 'answered' ? `${total} answered` : null}
          {block.state === 'cancelled' ? `${total}` : null}
        </span>
        {block.state === 'cancelled' && <span className="qcard__note">— cancelled</span>}
        <span className="qcard__gap" />
        {block.state === 'pending' && recCount > 0 && (
          <button
            type="button"
            className="qcard__accept"
            disabled={!interactive}
            onClick={onAcceptAll}
          >
            ✓ Accept {recCount === total ? 'all ' : ''}
            {recCount} recommended
          </button>
        )}
      </div>

      <div className="qcard__body">
        {block.questions.map((q, i) => (
          <Section
            key={i}
            q={q}
            idx={i}
            block={block}
            sel={sel[i] ?? { selected: [], freeText: '' }}
            isCurrent={i === current}
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
      </div>

      {/* 13c: a footer rail so the block always ends on a stated rule rather
          than trailing off. §8.6 still governs the button — a pure
          single-select card submits on the click that completes it (FR-18), so
          a Send there would be an affordance that can never be reached. */}
      {block.state === 'pending' && (
        <div className="qcard__foot">
          {showSubmit && (
            <button
              type="button"
              className="qcard__send"
              disabled={!interactive || !submitEnabled}
              onClick={() => {
                if (!interactive || !submitEnabled) return;
                void submit(buildAnswers(block.questions, sel));
              }}
            >
              Send {total > 1 ? `${total} answers` : 'answer'}
            </button>
          )}
          <span className="qcard__hint">
            {showSubmit
              ? 'pick what applies, then send'
              : total > 1
                ? 'pick one per question'
                : 'pick one'}
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
  isCurrent,
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
  isCurrent: boolean;
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

  return (
    <div className={'qsec' + (isCurrent ? ' qsec--current' : '')}>
      <div className="qsec__head">
        <span className="qsec__num">{sectionOrdinal(idx)}</span>
        {/* 13c: backticks in the question text were rendering as literal
            characters. Inline markdown, so `SessionMeta` sets as code. */}
        <span className="qsec__q">
          <InlineMarkdown text={q.question} />
        </span>
      </div>

      <div className="qsec__opts">
        {q.options.map((o, oi) => (
          <Option
            // Keyed by index, not label: FR-7 renders options verbatim, so two
            // identical labels are possible and must not collide.
            key={oi}
            o={o}
            multi={q.multiSelect}
            chosen={chosen.includes(o.label)}
            dimmed={answered && !chosen.includes(o.label)} // FR-19: unchosen rows dim
            interactive={interactive}
            onClick={() => onPick(idx, o.label)}
            onHover={onHover}
          />
        ))}

        {/* other… free-text row (§8.4; echoes the free-text answer when chosen — FR-19) */}
        {otherOpen && interactive ? (
          <div className="qopt qopt--other qopt--wide">
            <span className="qopt__label">
              <span className="qopt__glyph">{q.multiSelect ? '☐' : '○'}</span>
              <input
                className="qopt__input"
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
            </span>
          </div>
        ) : freeText !== null ? (
          <div
            className={'qopt qopt--on qopt--wide' + (interactive ? ' qopt--live' : '')}
            onClick={onOpenOther}
          >
            <span className="qopt__label">
              <span className="qopt__glyph">{q.multiSelect ? '☑' : '●'}</span>
              {freeText}
            </span>
          </div>
        ) : (
          <div
            className={'qopt qopt--other' + (interactive ? ' qopt--live' : '')}
            onClick={onOpenOther}
          >
            <span className="qopt__label">
              <span className="qopt__glyph">{q.multiSelect ? '☐' : '○'}</span>
              Something else…
            </span>
          </div>
        )}
      </div>

      {preview !== null && <div className="scz qsec__prev">{preview}</div>}
    </div>
  );
}

/**
 * 13c: the label rail is a FIXED width, so every description in the block
 * shares one left edge instead of stepping in and out per option. Below the
 * rail's own width the description wraps under the label rather than crushing
 * to one word per line.
 */
function Option({
  o,
  multi,
  chosen,
  dimmed,
  interactive,
  onClick,
  onHover,
}: {
  o: QuestionOption;
  multi: boolean;
  chosen: boolean;
  dimmed: boolean;
  interactive: boolean;
  onClick: () => void;
  onHover: (label: string | null) => void;
}) {
  // Recommended-but-unpicked is its own quiet state: an olive ring rather than
  // a fill, so the block still has exactly one filled row per question and the
  // suggestion never reads as an answer already given.
  const rec = !chosen && isRecommended(o);
  const cls =
    'qopt' +
    (chosen ? ' qopt--on' : '') +
    (rec ? ' qopt--rec' : '') +
    (dimmed ? ' qopt--dim' : '') +
    (interactive ? ' qopt--live' : '');

  return (
    <div
      className={cls}
      onClick={onClick}
      onMouseEnter={interactive ? () => onHover(o.label) : undefined}
      onMouseLeave={interactive ? () => onHover(null) : undefined}
    >
      <span className="qopt__label">
        <span className="qopt__glyph">{multi ? (chosen ? '☑' : '☐') : chosen ? '●' : '○'}</span>
        {displayLabel(o.label)}
      </span>
      {o.description !== '' && (
        <span className="qopt__desc">
          <InlineMarkdown text={o.description} />
        </span>
      )}
    </div>
  );
}

import { questionAnswerKey } from '../../lib/question-answers';
import { requestReplyAvailable, requestReplyPending, submitRequestReply } from '../../lib/request-replies';
import { useStore } from '../../lib/store';
// session-questions — question card renderer for the SESSION transcript, drawn
// to Graphite & Signal (Figma 02 "Question / Pending", 03 "Question / Answered").
// A pending card shows ONE question at a time — head (`Question · 1 of 2` +
// Accept recommended), the question as a title, the options as full-width rows
// with a radio/checkbox and a keycap, the always-open "Something else" field,
// and a footer with the Answer button. An answered card collapses to one
// record per question. All selection/submit logic is pure in ./question-card
// (unit-tested); this file is DOM assembly + card-local UI state.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { QuestionOption, SessionQuestion } from '../../../contract/common';
import type { QuestionConversationBlock } from '../../../contract/session-questions';
import { sessionAnswerQuestion } from '../../lib/api';
import { focusedSessionId } from '../../lib/layoutStore';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { StateIcon } from '../../ui/StateIcon';
import { InlineMarkdown } from '../conversation/MarkdownView';
import {
    acceptRecommended,
    advanceStep,
    allComplete,
    answerSummary,
    buildAnswers,
    currentSection,
    displayLabel,
    initialSelections,
    isRecommended,
    isRecommendedSelection,
    pickOption,
    questionHeading,
    recommendedCount,
    sectionComplete,
    setFreeText,
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
  if (block.state !== 'pending') return <ResolvedQuestion block={block} />;
  return <PendingQuestion block={block} sessionId={sessionId} />;
}

// ---------- answered / cancelled (Figma 03) ----------

function ResolvedQuestion({ block }: { block: QuestionConversationBlock }) {
  const cancelled = block.state === 'cancelled';
  return (
    <div className={'qdone' + (cancelled ? ' qdone--cancelled' : '')}>
      {block.questions.map((q, i) => {
        // FR-19: the record is rebuilt from the persisted answer string, so it
        // survives hydration with no card-local state.
        const summary = cancelled ? null : answerSummary(q, block.answers?.[questionAnswerKey(q)]);
        return (
          <div key={q.id ?? i} className="qdone__item">
            <div className="qdone__head">
              <StateIcon kind={cancelled ? 'idle' : 'done'} size={14} className="qdone__glyph" />
              <span className="qdone__q">
                <InlineMarkdown text={q.question} />
              </span>
              {i === 0 && <span className="qdone__meta">{cancelled ? 'cancelled' : 'answered'}</span>}
            </div>
            {summary !== null && summary.text !== '' && (
              <div className="qdone__answer">
                <span className="qdone__value">{summary.text}</span>
                {summary.recommended && <span className="qdone__note">· recommended</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- pending (Figma 02) ----------

function PendingQuestion({ block, sessionId }: { block: QuestionConversationBlock; sessionId: string }) {
  const [sel, setSel] = useState<SectionSelection[]>(() => initialSelections(block.questions));
  const [step, setStep] = useState(0);
  const [inFlight, setInFlight] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  // FR-21 race check: the failure path must not re-enable a card an event
  // already resolved. Ref, so the async submit sees the CURRENT block state.
  const resolvedRef = useRef(false);
  resolvedRef.current = !requestReplyPending(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId);

  const meta = useStore((s) => s.sessions.find((session) => session.id === sessionId));
  const writable = requestReplyPending(meta, block.blockId);
  const hasSecrets = block.questions.some((q) => q.isSecret);
  useEffect(() => {
    // A secret must not linger in card state once the card can no longer send it.
    if (hasSecrets && !writable) setSel(initialSelections(block.questions));
  }, [hasSecrets, writable, block.questions]);
  const interactive = writable && !inFlight;

  const total = block.questions.length;
  const shown = Math.min(step, Math.max(0, total - 1));
  const q = block.questions[shown];
  const cur = sel[shown] ?? { selected: [], freeText: '' };
  const recCount = recommendedCount(block.questions);

  const submit = useCallback(
    (answers: Record<string, string>) =>
      interactive &&
      requestReplyAvailable(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId) &&
      submitAnswers({
        answers,
        answer: (ans) =>
          submitRequestReply(useStore.getState().sessions.find((s) => s.id === sessionId), block.blockId, () =>
            sessionAnswerQuestion(sessionId, block.blockId, ans),
          ),
        setInFlight,
        isResolved: () => resolvedRef.current,
        log: (m) => console.error(hasSecrets ? 'Could not submit question answer.' : m),
        onSubmitted: () => {
          if (hasSecrets) setSel(initialSelections(block.questions));
        },
      }),
    [interactive, sessionId, block.blockId, block.questions, hasSecrets],
  );

  const answer = useCallback(() => {
    if (!interactive) return;
    const next = advanceStep(sel, shown);
    if (next.kind === 'next') setStep(next.step);
    else if (next.kind === 'submit') void submit(buildAnswers(block.questions, sel));
  }, [interactive, sel, shown, submit, block.questions]);

  const acceptAll = () => {
    if (!interactive) return;
    const next = acceptRecommended(block.questions, sel);
    setSel(next);
    if (allComplete(next)) void submit(buildAnswers(block.questions, next));
    else setStep(Math.max(0, currentSection(next)));
  };

  const pick = useCallback(
    (label: string) => {
      if (!interactive) return;
      setSel((s) => pickOption(block.questions, s, shown, label));
    },
    [interactive, block.questions, shown],
  );

  const allowsOther = q !== undefined && (q.options.length === 0 || q.isOther !== false);

  // Figma 02 keycaps: `1`–`N` pick an option, `N+1` jumps into "Something
  // else", ⏎ answers. Same standing-down rules as the approval card: only for
  // the focused session, only while this card is actually displayed, and never
  // while a text field or the terminal holds focus.
  useEffect(() => {
    if (!interactive || q === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      // A focused button already answers ⏎ with its own click.
      if (el && el.tagName === 'BUTTON' && e.key === 'Enter') return;
      // ⏎ on the roster opens the highlighted row — leave it to pane [1].
      if (e.key === 'Enter' && useStore.getState().focusedPane !== 'main') return;
      if (el && el.closest('.xterm') !== null) return;
      if (focusedSessionId(useStore.getState()) !== sessionId) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      let handled = true;
      if (e.key === 'Enter') answer();
      else if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        if (n < q.options.length) pick(q.options[n]!.label);
        else if (n === q.options.length && allowsOther) otherRef.current?.focus();
        else handled = false;
      } else handled = false;
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [interactive, q, sessionId, answer, pick, allowsOther]);

  if (q === undefined) return null;

  const advance = advanceStep(sel, shown);
  const lastStep = advance.kind !== 'next';
  const multiStep = total > 1;
  // FR-17: preview of the hovered-or-selected option beneath the options.
  const preview =
    (interactive && hovered !== null ? q.options.find((o) => o.label === hovered)?.preview : undefined) ??
    q.options.find((o) => cur.selected.includes(o.label) && o.preview)?.preview ??
    null;

  return (
    <div ref={rootRef} className={'qcard' + (inFlight ? ' qcard--inflight' : '')}>
      <div className="qcard__head">
        <StateIcon kind="question" size={14} />
        <span className="qcard__label">{questionHeading(shown, total)}</span>
        {recCount > 0 && (
          <button type="button" className="qcard__accept" disabled={!interactive} onClick={acceptAll}>
            Accept recommended
            {isRecommendedSelection(block.questions, sel) && lastStep && <Kbd keys="⏎" />}
          </button>
        )}
      </div>

      {/* Backticks in the question set as code (inline markdown). */}
      <div className="qcard__title">
        <InlineMarkdown text={q.question} />
      </div>

      {q.options.length > 0 && (
        <div className="qcard__options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.header || q.question}>
          {q.options.map((o, oi) => (
            <Option
              // Keyed by index, not label: FR-7 renders options verbatim, so two
              // identical labels are possible and must not collide.
              key={oi}
              o={o}
              index={oi}
              multi={q.multiSelect}
              chosen={cur.selected.includes(o.label)}
              interactive={interactive}
              onPick={() => pick(o.label)}
              onHover={setHovered}
            />
          ))}
        </div>
      )}

      {allowsOther && (
        <OtherField
          q={q}
          inputRef={otherRef}
          value={cur.freeText}
          ordinal={q.options.length + 1}
          interactive={interactive}
          onChange={(text) => setSel((s) => setFreeText(block.questions, s, shown, text))}
          onSubmit={answer}
        />
      )}

      {preview !== null && <div className="scz qcard__preview">{preview}</div>}

      <div className="qcard__foot">
        <span className="qcard__hint">
          {block.blocking === false ? 'The session keeps going while this waits' : 'Session is paused until you answer'}
        </span>
        {multiStep && shown > 0 && (
          <Button variant="ghost" className="qcard__back" disabled={!interactive} onClick={() => setStep(shown - 1)}>
            Back
          </Button>
        )}
        <Button
          variant="attention"
          className="qcard__answer"
          shortcut="⏎"
          disabled={!interactive || !sectionComplete(cur)}
          onClick={answer}
        >
          {lastStep ? (multiStep ? `Answer ${total}` : 'Answer') : 'Next'}
        </Button>
      </div>
    </div>
  );
}

function Option({
  o,
  index,
  multi,
  chosen,
  interactive,
  onPick,
  onHover,
}: {
  o: QuestionOption;
  index: number;
  multi: boolean;
  chosen: boolean;
  interactive: boolean;
  onPick: () => void;
  onHover: (label: string | null) => void;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={chosen}
      className={'qcard__option' + (chosen ? ' qcard__option--on' : '')}
      disabled={!interactive}
      onClick={onPick}
      onMouseEnter={interactive ? () => onHover(o.label) : undefined}
      onMouseLeave={interactive ? () => onHover(null) : undefined}
    >
      <span className={multi ? 'qcard__check' : 'qcard__radio'} aria-hidden />
      <span className="qcard__text">
        <span className="qcard__option-title">
          <span className="qcard__option-label">{displayLabel(o.label)}</span>
          {isRecommended(o) && <span className="qcard__rec">Recommended</span>}
        </span>
        {o.description !== '' && (
          <span className="qcard__desc">
            <InlineMarkdown text={o.description} />
          </span>
        )}
      </span>
      {index < 9 && <Kbd keys={String(index + 1)} />}
    </button>
  );
}

function OtherField({
  q,
  inputRef,
  value,
  ordinal,
  interactive,
  onChange,
  onSubmit,
}: {
  q: SessionQuestion;
  inputRef: RefObject<HTMLInputElement>;
  value: string;
  ordinal: number;
  interactive: boolean;
  onChange: (text: string) => void;
  onSubmit: () => void;
}) {
  return (
    <label className={'qcard__other' + (value.trim() !== '' ? ' qcard__other--on' : '')}>
      <input
        ref={inputRef}
        className="qcard__other-input"
        type={q.isSecret ? 'password' : 'text'}
        aria-label={q.header || q.question}
        autoComplete="off"
        placeholder={q.options.length === 0 ? 'Type your answer' : 'Something else — type your own answer'}
        value={value}
        disabled={!interactive}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape') {
            // §3 flow 4: Escape empties the field and hands focus back.
            e.preventDefault();
            onChange('');
            e.currentTarget.blur();
          }
        }}
      />
      {q.options.length > 0 && ordinal <= 9 && <Kbd keys={String(ordinal)} />}
    </label>
  );
}

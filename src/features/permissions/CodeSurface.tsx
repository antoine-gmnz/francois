// The recessed block an approval card sets its ask on (Figma 04 "Command"):
// the thing being approved, set as code — a tokenized command, a request line
// or a real diff — over one faint line saying where it runs. Every string it
// renders is derived purely in ./permission-code; this file is DOM assembly.
//
// The block doubles as the disclosure control when the card has detail to
// reveal (Figma 05 shows the raw arguments under it): the surface already IS
// the headline, so a second "details" row would say nothing new.

import { Icon } from '../../ui/Icon';
import type { CodeSurface } from './permission-code';
import './permissions.css';

export default function CodeSurfaceView({
  surface,
  open,
  onToggle,
}: {
  surface: CodeSurface;
  /** undefined ⇒ there is nothing to disclose, so the block is inert. */
  open?: boolean;
  onToggle?: () => void;
}) {
  const inner = (
    <>
      <span className="csurf__main">
        {body(surface)}
        <Where surface={surface} />
      </span>
      {onToggle !== undefined && (
        <Icon name={open === true ? 'chevron-down' : 'chevron-right'} size={14} className="csurf__caret" />
      )}
    </>
  );
  // A <button> only when there IS something to disclose — otherwise an inert
  // stop in the tab order that answers nothing when pressed.
  return onToggle !== undefined ? (
    <button
      type="button"
      className="csurf csurf--toggle"
      onClick={onToggle}
      aria-expanded={open}
      title={open === true ? 'Hide the tool input' : 'Show the tool input'}
    >
      {inner}
    </button>
  ) : (
    <div className="csurf">{inner}</div>
  );
}

/** The faint second line: where it runs, or which file an edit touches. */
function Where({ surface }: { surface: CodeSurface }) {
  const { context, counts } = surface.header;
  if (context === '' && counts === null) return null;
  return (
    <span className="csurf__where">
      {context !== '' && (
        <span className="csurf__context" title={context}>
          {surface.kind === 'diff' ? context : `in ${context}`}
        </span>
      )}
      {counts !== null && (
        <>
          <span className="csurf__count csurf__count--add">+{counts.added}</span>
          <span className="csurf__count csurf__count--del">−{counts.removed}</span>
        </>
      )}
    </span>
  );
}

function body(surface: CodeSurface) {
  if (surface.kind === 'command') {
    return (
      <span className="csurf__line">
        <span className="csurf__prompt">$</span>
        <span className="csurf__code">
          {surface.tokens.map((t, i) => (
            // Index-keyed on purpose: a command is a positional sequence, and
            // the same word legitimately repeats (`cp a a`).
            <span key={i} className={`csurf__tok csurf__tok--${t.tone}`}>
              {i > 0 ? ' ' : ''}
              {t.text}
            </span>
          ))}
        </span>
      </span>
    );
  }

  if (surface.kind === 'fetch') {
    return (
      <span className="csurf__line">
        <span className="csurf__prompt">↗</span>
        <span className="csurf__code">
          <span className="csurf__tok csurf__tok--binary">{surface.method}</span>{' '}
          <span className="csurf__tok csurf__tok--arg">{surface.scheme}</span>
          {/* The host is the only part of a URL that decides whether the request
              is safe, so it is the only part that carries weight. */}
          <span className="csurf__tok csurf__tok--host">{surface.host}</span>
          <span className="csurf__tok csurf__tok--arg">{surface.path}</span>
        </span>
      </span>
    );
  }

  if (surface.kind === 'diff') {
    return (
      <span className="csurf__diff">
        {surface.rows.map((r, i) => (
          <span key={i} className={`csurf__row csurf__row--${r.kind}`}>
            <span className="csurf__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            <span className="csurf__text">{r.text}</span>
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="csurf__line">
      <span className="csurf__code csurf__code--plain">{surface.text}</span>
    </span>
  );
}

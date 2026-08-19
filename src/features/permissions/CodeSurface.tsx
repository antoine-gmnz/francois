// design 9b — the inset surface an approval card sets its ask on. One header
// strip answering *what language or channel* · *where* · *how big the blast
// radius is*, then one of four payloads. Every string it renders is derived
// purely in ./permission-code; this file is DOM assembly only.
//
// The header strip is also the disclosure control when the card has detail to
// reveal: the surface already IS the headline, so hanging the caret anywhere
// else would add a second row that says nothing.

import type { CodeSurface } from './permission-code';
import './permissions.css';

export default function CodeSurfaceView({
  surface,
  open,
  onToggle,
}: {
  surface: CodeSurface;
  /** undefined ⇒ there is nothing to disclose, so the strip is inert. */
  open?: boolean;
  onToggle?: () => void;
}) {
  const { language, context, blast, counts } = surface.header;
  const interactive = onToggle !== undefined;
  const strip = (
    <>
      <span className="csurf__lang">{language}</span>
      {/* The path or cwd truncates; the whole string stays on the title. */}
      {context !== '' && (
        <span className="csurf__context" title={context}>
          {context}
        </span>
      )}
      <span className="csurf__gap" />
      {counts !== null && (
        <>
          <span className="csurf__count csurf__count--add">+{counts.added}</span>
          <span className="csurf__count csurf__count--del">−{counts.removed}</span>
        </>
      )}
      {blast !== null && <span className="csurf__blast">{blast}</span>}
      {interactive && <span className="csurf__caret">{open === true ? '▾' : '▸'}</span>}
    </>
  );
  return (
    <div className="csurf">
      {/* A <button> only when there IS something to disclose — a resolved card
          with no input dump and no cwd would otherwise put an inert stop in the
          tab order that answers nothing when it is pressed. */}
      {interactive ? (
        <button type="button" className="csurf__head" onClick={onToggle} aria-expanded={open}>
          {strip}
        </button>
      ) : (
        <div className="csurf__head csurf__head--static">{strip}</div>
      )}
      <div className="csurf__body">{body(surface)}</div>
    </div>
  );
}

function body(surface: CodeSurface) {
  if (surface.kind === 'command') {
    return (
      <div className="csurf__line">
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
      </div>
    );
  }

  if (surface.kind === 'fetch') {
    return (
      <div className="csurf__line">
        <span className="csurf__prompt">↗</span>
        <span className="csurf__code">
          <span className="csurf__tok csurf__tok--binary">{surface.method}</span>{' '}
          <span className="csurf__tok csurf__tok--arg">{surface.scheme}</span>
          {/* The host is the only part of a URL that decides whether the request
              is safe, so it is the only part that carries a colour. */}
          <span className="csurf__tok csurf__tok--host">{surface.host}</span>
          <span className="csurf__tok csurf__tok--arg">{surface.path}</span>
        </span>
      </div>
    );
  }

  if (surface.kind === 'diff') {
    return (
      <div className="csurf__diff">
        {surface.rows.map((r, i) => (
          <div key={i} className={`csurf__row csurf__row--${r.kind}`}>
            <span className="csurf__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            <span className="csurf__text">{r.text}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="csurf__line">
      <span className="csurf__code csurf__code--plain">{surface.text}</span>
    </div>
  );
}

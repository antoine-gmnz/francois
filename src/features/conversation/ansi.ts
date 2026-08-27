// command-inspect (design 16a, output band): a step's captured output is raw
// bytes — whatever the tool wrote, escape sequences included. A terminal renders
// those; a bare <pre> renders them as `←[0;32m` litter and drops the colour the
// program meant. This is the reader that closes the gap: SGR sequences become
// styled spans, every other escape sequence is swallowed, and `\r` clears the
// line the way a cursor return does.
//
// The palette is deliberately the SAME sixteen tokens
// `features/shell/xterm-theme.ts` hands xterm (see `.ansi-fg-*` in
// conversation.css) — a log read in the record and the same log watched live in
// the SHELL tab must colour the same bytes the same way. 256-colour and
// truecolour have no token to land on, so they resolve to a literal `rgb()`
// carried on the span itself.
//
// Kept framework-free so it is unit-tested directly (ansi.test.ts) — this
// project's vitest has no DOM renderer.

const ESC = '\u001b';
const BEL = '\u0007';

/** 0-15 in SGR order; the suffix of the `.ansi-fg-*` / `.ansi-bg-*` classes. */
const NAMED = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const;

type AnsiColor = { kind: 'named'; index: number } | { kind: 'rgb'; css: string };

export interface AnsiSpan {
  text: string;
  /** Token-backed classes (`''` when the span carries none). */
  className: string;
  /** Only ever set for 256-colour / truecolour, which have no token class. */
  color?: string;
  /** Only ever set for 256-colour / truecolour, which have no token class. */
  background?: string;
}

interface SgrState {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function blankState(): SgrState {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

/** The xterm 256-colour cube: 0-15 named, 16-231 a 6×6×6 cube, 232-255 grey. */
function xterm256(n: number): AnsiColor {
  if (n < 16) return { kind: 'named', index: n };
  if (n < 232) {
    const level = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return { kind: 'rgb', css: `rgb(${level[Math.floor(i / 36) % 6]}, ${level[Math.floor(i / 6) % 6]}, ${level[i % 6]})` };
  }
  const g = 8 + (n - 232) * 10;
  return { kind: 'rgb', css: `rgb(${g}, ${g}, ${g})` };
}

/**
 * One `m` sequence's parameters, applied in order: the extended-colour forms
 * (`38;5;n`, `38;2;r;g;b`) eat their own arguments, and an unrecognised
 * parameter is skipped rather than aborting the sequence — which is what a
 * terminal does.
 */
function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(state, blankState());
    else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 7) state.inverse = true;
    else if (p === 22) {
      state.bold = false;
      state.dim = false;
    } else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p === 27) state.inverse = false;
    else if (p >= 30 && p <= 37) state.fg = { kind: 'named', index: p - 30 };
    else if (p === 39) state.fg = null;
    else if (p >= 40 && p <= 47) state.bg = { kind: 'named', index: p - 40 };
    else if (p === 49) state.bg = null;
    else if (p >= 90 && p <= 97) state.fg = { kind: 'named', index: p - 90 + 8 };
    else if (p >= 100 && p <= 107) state.bg = { kind: 'named', index: p - 100 + 8 };
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5 && params.length > i + 2) {
        state[target] = xterm256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2 && params.length > i + 4) {
        state[target] = { kind: 'rgb', css: `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})` };
        i += 4;
      }
    }
  }
}

/**
 * Bold brightens a named 0-7 foreground — xterm.js's own
 * `drawBoldTextInBrightColors` default, so the SHELL tab and the record agree
 * on what `\e[1;32m` looks like.
 */
function resolvedFg(state: SgrState): AnsiColor | null {
  const fg = state.inverse ? state.bg : state.fg;
  if (state.bold && fg?.kind === 'named' && fg.index < 8) return { kind: 'named', index: fg.index + 8 };
  return fg;
}

function spanStyle(state: SgrState): Pick<AnsiSpan, 'className' | 'color' | 'background'> {
  const fg = resolvedFg(state);
  const bg = state.inverse ? state.fg : state.bg;
  const classes: string[] = [];
  if (state.bold) classes.push('ansi-bold');
  if (state.dim) classes.push('ansi-dim');
  if (state.italic) classes.push('ansi-italic');
  if (state.underline) classes.push('ansi-underline');
  if (fg?.kind === 'named') classes.push(`ansi-fg-${NAMED[fg.index]}`);
  if (bg?.kind === 'named') classes.push(`ansi-bg-${NAMED[bg.index]}`);
  const out: Pick<AnsiSpan, 'className' | 'color' | 'background'> = { className: classes.join(' ') };
  if (fg?.kind === 'rgb') out.color = fg.css;
  if (bg?.kind === 'rgb') out.background = bg.css;
  return out;
}

/** A C0 control that neither carries text nor is handled by the loop below — a
 *  terminal eats these, so a `<pre>` must too. Tab and newline ARE text (they
 *  are what carries a log's indentation), and ESC / CR never reach here. */
function isDroppedControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return code < 0x20 || code === 0x7f;
}

/**
 * The captured text as styled spans, in reading order. Spans never straddle a
 * `\n` (so `\r` can drop the line drawn so far without touching the ones above
 * it), and a run with no styling at all comes back with `className: ''` —
 * callers render it as a plain span rather than special-casing it.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  const state = blankState();
  let lineStart = 0; // index in `out` where the line being drawn began
  let buffer = '';
  let bufferStyle = spanStyle(state);

  const flush = () => {
    if (buffer === '') return;
    out.push({ text: buffer, ...bufferStyle });
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ESC) {
      const next = text[i + 1];
      if (next === '[') {
        // CSI: parameters, then a final byte in @-~. Only `m` means anything here.
        let j = i + 2;
        while (j < text.length && !(text[j] >= '@' && text[j] <= '~')) j++;
        if (j < text.length) {
          if (text[j] === 'm') {
            flush();
            const raw = text.slice(i + 2, j);
            const params = raw === '' ? [0] : raw.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10) || 0));
            applySgr(state, params);
            bufferStyle = spanStyle(state);
          }
          i = j;
          continue;
        }
        // Unterminated — the capture cut mid-sequence; drop the rest.
        break;
      }
      if (next === ']') {
        // OSC: runs to BEL or ST. Carries no text (window titles, hyperlinks).
        let j = i + 2;
        while (j < text.length && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === '\\')) j++;
        i = text[j] === ESC ? j + 1 : j;
        continue;
      }
      i += 1; // a two-byte escape (charset selection, RI, …) — nothing to draw
      continue;
    }
    if (ch === '\r') {
      // A CR that ENDS a line is half of a CRLF terminator, not a cursor
      // return — the line it closes must survive. Only a CR with more text
      // after it is the rewrite-in-place a progress bar does, and there the
      // line drawn so far is about to be overwritten, so dropping it is
      // exactly what you would have seen. (Windows and any PTY-captured
      // output are CRLF throughout: reading those as rewrites blanks every
      // line but the last.)
      let k = i;
      while (text[k] === '\r') k++;
      if (k >= text.length || text[k] === '\n') {
        i = k - 1; // let the `\n` below close the line (or stop at the end)
        continue;
      }
      buffer = '';
      out.length = lineStart;
      continue;
    }
    if (ch === '\n') {
      buffer += ch;
      flush();
      lineStart = out.length;
      continue;
    }
    if (isDroppedControl(ch.charCodeAt(0))) continue;
    buffer += ch;
  }
  flush();
  return out;
}

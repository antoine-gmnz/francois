// command-inspect: syntax colour for the unfolded step record (StepDetailPanel).
// Two lexers — a shell command line (bash and PowerShell share enough surface
// for one pass) and the generic tool input's pretty-printed JSON.
//
// Unlike permissions/permission-code's tokenizeCommand, which re-joins words
// with single spaces for a one-line approval card, these keep EVERY character:
// the concatenated token texts always equal the input, so a multi-line heredoc,
// a `\` continuation or a hand-aligned argument list renders exactly as the
// model wrote it. Deliberately not parsers — a wrong colour is cosmetic, a lost
// character would misreport what ran.

export type SyntaxTone =
  | 'plain'
  | 'command'
  | 'keyword'
  | 'flag'
  | 'string'
  | 'variable'
  | 'operator'
  | 'comment'
  | 'number'
  | 'key'
  | 'literal'
  | 'punct';

export interface SyntaxToken {
  tone: SyntaxTone;
  text: string;
}

/** Longest first, so `>>` never lexes as two `>` and `2>&1` never as `2` `>` `&` `1`. */
const SHELL_OPERATORS = ['2>&1', '&&', '||', '>>', '2>', '$(', '|', ';', '&', '>', '<', '(', ')', '{', '}'];

/** The operators after which the next word is a program again. */
const COMMAND_STARTERS = new Set(['&&', '||', '|', ';', '&', '$(', '(', '{']);

/** Reserved words that open or continue a construct — the word after them is a command. */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'foreach', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'return', 'try', 'catch', 'finally', 'param', 'time',
]);

/** Keywords that END a construct: the word after them is not a new command. */
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac', 'in', 'return']);

const WORD_BREAK = /[\s'"`$|&;<>(){}]/;

function push(out: SyntaxToken[], tone: SyntaxTone, text: string) {
  out.push({ tone, text });
}

/** Index just past the quote closing the one at `start`, honouring `\` escapes in `"…"`. */
function quoteEnd(src: string, start: number): number {
  const q = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && q === '"') {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return src.length;
}

/** `$NAME`, `${…}`, `$env:NAME`, `$?`/`$1`/`$@` — the variable's end, or `start` when the `$` is bare. */
function variableEnd(src: string, start: number): number {
  const next = src[start + 1];
  if (next === '{') {
    const close = src.indexOf('}', start + 2);
    return close === -1 ? src.length : close + 1;
  }
  const m = /^(?:[A-Za-z_][\w]*(?::[A-Za-z_][\w]*)?|[0-9?@#*!$-])/.exec(src.slice(start + 1));
  return m ? start + 1 + m[0].length : start;
}

/** Lex a shell command line (bash or PowerShell) into lossless coloured tokens. */
export function highlightShell(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let expectCommand = true;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      const ws = src.slice(i, j);
      // A newline starts a new command unless the line was continued (`\`, PowerShell's backtick).
      if (ws.includes('\n')) {
        const prev = src.slice(0, i).trimEnd().slice(-1);
        if (prev !== '\\' && prev !== '`') expectCommand = true;
      }
      push(out, 'plain', ws);
      i = j;
      continue;
    }

    const atWordStart = i === 0 || /\s|[;|&(]/.test(src[i - 1]!);
    if (c === '#' && atWordStart) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      push(out, 'comment', src.slice(i, end));
      i = end;
      continue;
    }

    if (c === '"' || c === "'") {
      const end = quoteEnd(src, i);
      push(out, 'string', src.slice(i, end));
      i = end;
      expectCommand = false;
      continue;
    }

    if (c === '$' && src[i + 1] !== '(') {
      const end = variableEnd(src, i);
      if (end > i) {
        push(out, 'variable', src.slice(i, end));
        i = end;
        continue;
      }
    }

    const op = atWordStart || !/[0-9]/.test(c) ? SHELL_OPERATORS.find((o) => src.startsWith(o, i)) : undefined;
    if (op !== undefined) {
      push(out, 'operator', op);
      i += op.length;
      if (COMMAND_STARTERS.has(op)) expectCommand = true;
      continue;
    }

    let j = i;
    while (j < src.length && !WORD_BREAK.test(src[j]!)) j++;
    if (j === i) j = i + 1; // a lone breaker the rules above passed on (a bare `$`, a backtick)
    const word = src.slice(i, j);
    i = j;

    if (expectCommand && SHELL_KEYWORDS.has(word)) {
      push(out, 'keyword', word);
      expectCommand = !CLOSING_KEYWORDS.has(word);
      continue;
    }
    if (expectCommand && /^[A-Za-z_]\w*=/.test(word)) {
      // `FOO=1 npm test` — an environment prefix; the program is still ahead.
      const eq = word.indexOf('=');
      push(out, 'variable', word.slice(0, eq));
      push(out, 'operator', '=');
      if (eq + 1 < word.length) push(out, 'plain', word.slice(eq + 1));
      continue;
    }
    if (expectCommand) {
      push(out, 'command', word);
      expectCommand = false;
      continue;
    }
    if (word.startsWith('-') && word.length > 1 && !/^-\d/.test(word)) push(out, 'flag', word);
    else if (/^\d+(\.\d+)?$/.test(word)) push(out, 'number', word);
    else push(out, 'plain', word);
  }
  return out;
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** Lex pretty-printed JSON into lossless tokens: keys, strings, numbers, literals, punctuation. */
export function highlightJson(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let last = 0;
  for (const m of src.matchAll(JSON_TOKEN)) {
    const at = m.index;
    if (at > last) push(out, 'plain', src.slice(last, at));
    if (m[1] !== undefined) {
      push(out, m[2] !== undefined ? 'key' : 'string', m[1]);
      if (m[2] !== undefined) push(out, 'punct', m[2]);
    } else if (m[3] !== undefined) push(out, 'number', m[3]);
    else if (m[4] !== undefined) push(out, 'literal', m[4]);
    else push(out, 'punct', m[0]);
    last = at + m[0].length;
  }
  if (last < src.length) push(out, 'plain', src.slice(last));
  return out;
}

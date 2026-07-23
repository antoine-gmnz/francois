// Minimal, self-contained Markdown parser for the SESSION transcript.
//
// Claude's assistant replies arrive as Markdown source; the conversation view used
// to print them verbatim (raw `**bold**`, `# heading`, ``` fences, …). This turns
// that source into a small AST that <Markdown> renders with the terminal theme.
//
// Pure + total — it never throws and never loses text: anything it can't classify
// falls through to a plain-text node, so the rendered output is never *worse* than
// the raw source. Scope is the common subset Claude actually emits (headings,
// emphasis, inline + fenced code, links, lists, blockquotes, rules, GFM tables);
// exotic CommonMark corners (setext headings, reference links, triple-emphasis)
// degrade gracefully rather than being handled exactly. Kept framework-free so it
// unit-tests without the DOM, like the other pure modules here.

// ---------- AST ----------

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'del'; children: MdInline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'br' };

export type TableAlign = 'left' | 'right' | 'center' | null;

export type MdBlock =
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'hr' }
  | { type: 'table'; align: TableAlign[]; header: MdInline[][]; rows: MdInline[][][] };

// ---------- line helpers ----------

const blank = (l: string | undefined): boolean => l === undefined || l.trim() === '';
const indentOf = (l: string): number => l.length - l.replace(/^\s+/, '').length;

const RE_FENCE = /^\s{0,3}(```+|~~~+)(.*)$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^ {0,3}>/;

interface Marker {
  indent: number;
  ordered: boolean;
  start: number;
  content: string;
  width: number; // columns from line start to the item's content
}

function listMarker(line: string): Marker | null {
  const u = line.match(/^(\s*)([-*+])([ \t]+)(.*)$/);
  if (u) {
    return { indent: u[1].length, ordered: false, start: 1, content: u[4], width: u[1].length + 1 + u[3].length };
  }
  const o = line.match(/^(\s*)(\d{1,9})([.)])([ \t]+)(.*)$/);
  if (o) {
    return { indent: o[1].length, ordered: true, start: parseInt(o[2], 10), content: o[5], width: o[1].length + o[2].length + 1 + o[4].length };
  }
  return null;
}

// ---------- GFM tables ----------

function splitTableRow(line: string): string[] {
  let s = line.trim();
  s = s.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      buf += s[i + 1] ?? '';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  cells.push(buf);
  return cells.map((c) => c.trim());
}

function delimiterRow(line: string): TableAlign[] | null {
  if (!line.includes('-') || !/[|\-: ]/.test(line) || /[^|\-: \t]/.test(line.trim())) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align: TableAlign[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    align.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null);
  }
  return align;
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && delimiterRow(next) !== null;
}

// ---------- block parser ----------

function isBlockStart(line: string | undefined, next: string | undefined): boolean {
  if (line === undefined) return false;
  if (RE_FENCE.test(line)) return true;
  if (RE_HEADING.test(line) && /#/.test(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  if (listMarker(line)) return true;
  if (isTableStart(line, next)) return true;
  return false;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return parseLines(lines);
}

function parseLines(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (blank(line)) {
      i++;
      continue;
    }

    // fenced code — an unterminated fence (mid-stream) runs to EOF
    const fence = line.match(RE_FENCE);
    if (fence) {
      const mark = fence[1];
      const fenceChar = mark[0];
      const lang = fence[2].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^\s{0,3}(```+|~~~+)\s*$/);
        if (close && close[1][0] === fenceChar && close[1].length >= mark.length) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    // ATX heading
    const h = line.match(RE_HEADING);
    if (h && /#/.test(line[0] === ' ' ? line.trimStart() : line)) {
      blocks.push({ type: 'heading', level: h[1].length, children: parseInline((h[2] ?? '').trim()) });
      i++;
      continue;
    }

    // thematic break
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // blockquote — collect the marked run, strip one '>' level, recurse
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseLines(inner) });
      continue;
    }

    // list
    if (listMarker(line)) {
      const res = parseList(lines, i);
      blocks.push(res.block);
      i = res.next;
      continue;
    }

    // GFM table
    if (isTableStart(line, lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline);
      const align = delimiterRow(lines[i + 1]) ?? [];
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    // paragraph — runs until a blank line or the start of another block. Each
    // source newline inside it becomes a hard break (faithful to chat output).
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    const children: MdInline[] = [];
    para.forEach((l, idx) => {
      if (idx > 0) children.push({ type: 'br' });
      children.push(...parseInline(l.replace(/^\s+/, '').replace(/[ \t]+$/, '')));
    });
    blocks.push({ type: 'paragraph', children });
  }

  return blocks;
}

// Consume consecutive items of one list at the marker's indent. Content more
// indented than an item's marker (nested lists, wrapped text) folds into that
// item and is parsed recursively.
function parseList(lines: string[], from: number): { block: Extract<MdBlock, { type: 'list' }>; next: number } {
  const first = listMarker(lines[from]) as Marker;
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const items: MdBlock[][] = [];
  let i = from;

  while (i < lines.length) {
    const lm = listMarker(lines[i]);
    if (!lm || lm.indent !== baseIndent || lm.ordered !== ordered) break;

    const contentIndent = lm.width;
    const itemLines: string[] = [lm.content];
    i++;

    while (i < lines.length) {
      const l = lines[i];

      if (blank(l)) {
        let k = i + 1;
        while (k < lines.length && blank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) >= contentIndent) {
          itemLines.push('');
          i++;
          continue;
        }
        break; // blank not followed by indented content ends the item
      }

      const lm2 = listMarker(l);
      if (lm2 && lm2.indent === baseIndent) break; // next sibling item

      if (indentOf(l) >= contentIndent) {
        itemLines.push(l.slice(contentIndent));
        i++;
        continue;
      }
      if (lm2 && lm2.indent > baseIndent) {
        itemLines.push(l.slice(Math.min(contentIndent, lm2.indent)));
        i++;
        continue;
      }
      if (!lm2 && indentOf(l) > baseIndent) {
        itemLines.push(l.replace(/^\s+/, ''));
        i++;
        continue;
      }
      break; // dedented, non-item line ends the list
    }

    items.push(parseLines(itemLines));
  }

  return { block: { type: 'list', ordered, start: first.start, items }, next: i };
}

// ---------- inline parser ----------

const ESCAPABLE = /[\\`*_{}\[\]()#+\-.!~>|]/;
const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

function runLength(text: string, pos: number, ch: string): number {
  let n = 0;
  while (text[pos + n] === ch) n++;
  return n;
}

function canOpen(text: string, pos: number, len: number, marker: string): boolean {
  const after = text[pos + len];
  if (after === undefined || /\s/.test(after)) return false;
  if (marker === '_' && isAlnum(text[pos - 1])) return false; // protect snake_case
  return true;
}

function canClose(text: string, pos: number, len: number, marker: string): boolean {
  const before = text[pos - 1];
  if (before === undefined || /\s/.test(before)) return false;
  if (marker === '_' && isAlnum(text[pos + len])) return false;
  return true;
}

function matchEmphasis(text: string, start: number, marker: string, openRun: number): { node: MdInline; end: number } | null {
  for (const len of openRun >= 2 ? [2, 1] : [1]) {
    if (!canOpen(text, start, len, marker)) continue;
    let j = start + len;
    while (j < text.length) {
      if (text[j] === marker) {
        const run = runLength(text, j, marker);
        if (run >= len && canClose(text, j, len, marker)) {
          const inner = text.slice(start + len, j);
          if (inner.length > 0) {
            const children = parseInline(inner);
            const node: MdInline = len === 2 ? { type: 'strong', children } : { type: 'em', children };
            return { node, end: j + len };
          }
        }
        j += run;
      } else {
        j++;
      }
    }
  }
  return null;
}

function matchLink(text: string, start: number): { text: string; href: string; end: number } | null {
  let depth = 0;
  let j = start;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= text.length || text[j + 1] !== '(') return null;
  const label = text.slice(start + 1, j);
  let k = j + 2;
  let pdepth = 1;
  for (; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '(') pdepth++;
    else if (ch === ')') {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  if (k >= text.length) return null;
  let dest = text.slice(j + 2, k).trim().replace(/^<(.*)>$/, '$1');
  const sp = dest.search(/\s/);
  const href = sp === -1 ? dest : dest.slice(0, sp);
  return { text: label, href, end: k + 1 };
}

export function parseInline(text: string): MdInline[] {
  const nodes: MdInline[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };
  const push = (n: MdInline) => {
    flush();
    nodes.push(n);
  };

  while (i < text.length) {
    const c = text[i];

    // backslash escape
    if (c === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // inline code — a backtick run closed by an equal-length run
    if (c === '`') {
      const run = runLength(text, i, '`');
      let j = i + run;
      let close = -1;
      while (j < text.length) {
        if (text[j] === '`' && runLength(text, j, '`') === run) {
          close = j;
          break;
        }
        j++;
      }
      if (close !== -1) {
        let code = text.slice(i + run, close);
        if (/^ .* $/.test(code) && code.trim() !== '') code = code.slice(1, -1);
        push({ type: 'code', value: code });
        i = close + run;
        continue;
      }
      buf += text.slice(i, i + run);
      i += run;
      continue;
    }

    // link
    if (c === '[') {
      const link = matchLink(text, i);
      if (link) {
        push({ type: 'link', href: link.href, children: parseInline(link.text) });
        i = link.end;
        continue;
      }
    }

    // strikethrough
    if (c === '~' && text[i + 1] === '~') {
      let j = i + 2;
      let close = -1;
      while (j < text.length - 1) {
        if (text[j] === '~' && text[j + 1] === '~') {
          close = j;
          break;
        }
        j++;
      }
      if (close !== -1) {
        push({ type: 'del', children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    // emphasis
    if (c === '*' || c === '_') {
      const run = runLength(text, i, c);
      const em = matchEmphasis(text, i, c, run);
      if (em) {
        push(em.node);
        i = em.end;
        continue;
      }
    }

    // bare autolink
    if (c === 'h') {
      const m = text.slice(i).match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/);
      if (m) {
        push({ type: 'link', href: m[0], children: [{ type: 'text', value: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return nodes;
}

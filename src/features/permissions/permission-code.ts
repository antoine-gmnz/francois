// design 9b — what is being approved is set as CODE, not prose. The old card
// stated the call as a sentence (`Bash(rm -rf node_modules && npm ci)`) plus a
// second line of context; 9b replaces both with one inset surface: a header
// answering *what language or channel*, *where*, and *how big the blast radius
// is*, then the thing itself — a tokenized command, a request line, or a real
// diff.
//
// Pure derivation from PermissionAsk, so every rule below is unit-testable
// without the DOM. Nothing here crosses IPC: the ask already carries the whole
// tool input as JSON (contract/common.ts PermissionAsk.inputJson).

import type { PermissionAsk } from '../../../contract/common';

// ---------- shape ----------

export interface CodeSurfaceHeader {
  /** Left, uppercase: the interpreter or channel — `bash`, `typescript`, `network`. */
  language: string;
  /** The where: a working directory for a command, a file path for an edit. '' when there is none. */
  context: string;
  /** Right: how big the blast radius is. null when there is nothing to warn about. */
  blast: string | null;
  /** Right: an edit's line counts, which take the blast slot on a diff surface. */
  counts: { added: number; removed: number } | null;
}

export type CommandTokenTone = 'binary' | 'flag' | 'arg' | 'operator' | 'string';

export interface CommandToken {
  tone: CommandTokenTone;
  text: string;
}

export type DiffRowKind = 'context' | 'add' | 'del' | 'elision';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

export type CodeSurface =
  | { kind: 'command'; header: CodeSurfaceHeader; tokens: CommandToken[] }
  | { kind: 'fetch'; header: CodeSurfaceHeader; method: string; scheme: string; host: string; path: string }
  | { kind: 'diff'; header: CodeSurfaceHeader; rows: DiffRow[] }
  | { kind: 'plain'; header: CodeSurfaceHeader; text: string };

// ---------- command tokenizing ----------

/** Chain and redirect forms, longest first so `>>` never matches as two `>`. */
const OPERATORS = ['&&', '||', '>>', '2>&1', '|', ';', '>', '<'];

/**
 * The subset that starts a NEW command, so the word after it is a binary. A
 * redirect is not one of them: the word after `>` is a file, and colouring it
 * as a binary would say a program runs that does not.
 */
const CHAIN_OPERATORS = ['&&', '||', '|', ';'];

/**
 * Split a command into coloured tokens: the binary, its flags, its arguments,
 * and the chain operators between them.
 *
 * Deliberately NOT a shell parser — it is a colouring pass over a line the user
 * is about to read, and a wrong colour is a cosmetic error where a wrong parse
 * would be a lie. What it does respect is quoting, because a quoted argument
 * containing a space or a `|` must not fracture into three tokens that suggest
 * a pipeline the command does not have.
 */
export function tokenizeCommand(command: string): CommandToken[] {
  const out: CommandToken[] = [];
  // The head of each segment is the binary; every operator re-arms this.
  let expectBinary = true;
  for (const word of splitWords(command)) {
    if (OPERATORS.includes(word)) {
      out.push({ tone: 'operator', text: word });
      expectBinary = CHAIN_OPERATORS.includes(word);
      continue;
    }
    if (expectBinary) {
      out.push({ tone: 'binary', text: word });
      expectBinary = false;
      continue;
    }
    if (word.startsWith('"') || word.startsWith("'")) {
      out.push({ tone: 'string', text: word });
      continue;
    }
    out.push({ tone: word.startsWith('-') ? 'flag' : 'arg', text: word });
  }
  return out;
}

/** Whitespace split that keeps quoted runs whole and lifts operators out of a word. */
function splitWords(command: string): string[] {
  const words: string[] = [];
  let buf = '';
  let quote: string | null = null;
  const flush = () => {
    if (buf !== '') words.push(buf);
    buf = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== null) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op !== undefined) {
      flush();
      words.push(op);
      i += op.length - 1;
      continue;
    }
    buf += c;
  }
  flush();
  return words;
}

// ---------- blast radius ----------

/**
 * The closed set of destructive shapes the header names. Deliberately small and
 * literal: this slot exists so the risk is legible BEFORE the command is read,
 * and a speculative warning on an ordinary command would train the reader to
 * ignore the slot entirely. Anything not on this list says nothing.
 */
const BLAST_PATTERNS: { re: RegExp; note: string }[] = [
  { re: /(^|\s)sudo(\s|$)/, note: 'runs as root' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, note: 'runs a downloaded script' },
  { re: /\bgit\s+push\b.*(--force|--force-with-lease|\s-f\b)/, note: 'rewrites remote history' },
  { re: /\bgit\s+reset\b.*--hard\b/, note: 'discards uncommitted changes' },
  { re: /\bgit\s+clean\b.*-[a-z]*f/, note: 'deletes untracked files' },
  { re: /\brm\b[^|;&]*\s-[a-z]*r/, note: 'deletes files recursively' },
];

function blastRadius(command: string): string | null {
  for (const { re, note } of BLAST_PATTERNS) {
    if (re.test(command)) return note;
  }
  return null;
}

// ---------- language ----------

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'c++',
  cc: 'c++',
  cs: 'c#',
  php: 'php',
  css: 'css',
  scss: 'scss',
  html: 'html',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
};

/**
 * What the header calls the file. Falls back to the bare extension — an unknown
 * extension still tells the reader more than `text` does — and to `text` for a
 * file with no extension at all.
 */
export function fileLanguage(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'text';
  const ext = name.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? ext;
}

// ---------- diff ----------

/** 9b: "two lines of unchanged context" — one pair, so the change stays the subject. */
const CONTEXT_LINES = 2;
/** A change taller than this is elided: the card is a decision, not a code review. */
const MAX_CHANGE_ROWS = 12;

interface Hunk {
  context: { before: string[]; after: string[] };
  removed: string[];
  added: string[];
}

/**
 * Trim the common head and tail off a replaced fragment, which is exactly the
 * derivation the core already uses for the `+N −M` meta (tools.rs edit_counts).
 * Doing it the same way here keeps the card's counts and the transcript row's
 * counts from ever disagreeing about the same edit.
 */
function hunkOf(oldText: string, newText: string): Hunk {
  const olds = oldText === '' ? [] : oldText.split('\n');
  const news = newText === '' ? [] : newText.split('\n');
  let lead = 0;
  while (lead < olds.length && lead < news.length && olds[lead] === news[lead]) lead++;
  let trail = 0;
  while (
    trail < olds.length - lead &&
    trail < news.length - lead &&
    olds[olds.length - 1 - trail] === news[news.length - 1 - trail]
  ) {
    trail++;
  }
  return {
    context: {
      before: olds.slice(Math.max(0, lead - CONTEXT_LINES), lead),
      after: olds.slice(olds.length - trail, olds.length - trail + CONTEXT_LINES),
    },
    removed: olds.slice(lead, olds.length - trail),
    added: news.slice(lead, news.length - trail),
  };
}

/**
 * Lay the hunks out as rows.
 *
 * There is NO line-number gutter, and that is deliberate: an Edit's tool input
 * carries `old_string`, not a file offset, so any number in that column would
 * be a position within the fragment while reading as a line of the file beside
 * it in the header. The sign column, the row tint and the context lines carry
 * the same information without inviting that misreading.
 */
function diffRows(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let dropped = 0;
  for (const h of hunks) {
    const changed = h.removed.length + h.added.length;
    const budget = Math.max(0, MAX_CHANGE_ROWS - rows.filter((r) => r.kind !== 'context').length);
    for (const text of h.context.before) rows.push({ kind: 'context', text });
    let shown = 0;
    for (const text of h.removed) {
      if (shown < budget) {
        rows.push({ kind: 'del', text });
        shown++;
      } else dropped++;
    }
    for (const text of h.added) {
      if (shown < budget) {
        rows.push({ kind: 'add', text });
        shown++;
      } else dropped++;
    }
    if (dropped === 0 || changed <= budget) {
      for (const text of h.context.after) rows.push({ kind: 'context', text });
    }
  }
  if (dropped > 0) rows.push({ kind: 'elision', text: `${dropped} more line${dropped === 1 ? '' : 's'}` });
  return rows;
}

// ---------- the surface ----------

const FETCH_TOOLS = ['WebFetch', 'Fetch', 'WebSearch'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

function parseInput(inputJson: string): Record<string, unknown> {
  if (inputJson === '') return {};
  try {
    const v: unknown = JSON.parse(inputJson);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** FR-20/9b: the ask, rendered as the code surface the card sets it in. */
export function askCodeSurface(ask: PermissionAsk): CodeSurface {
  const input = parseInput(ask.inputJson);

  if (ask.toolName === 'Bash' || ask.toolName === 'BashOutput') {
    // The summary is the fallback, not the source: it is already truncated for
    // a one-line label, and the surface has room for the real command.
    const command = str(input, 'command') || ask.summary;
    const described = str(input, 'description');
    return {
      kind: 'command',
      header: {
        language: 'bash',
        context: ask.cwd,
        // The tool's OWN description wins over a pattern match — it describes
        // this call, where the pattern list only recognizes a shape.
        blast: described !== '' ? described : blastRadius(command),
        counts: null,
      },
      tokens: tokenizeCommand(command),
    };
  }

  if (FETCH_TOOLS.includes(ask.toolName)) {
    const url = str(input, 'url') || (/^https?:\/\//.test(ask.summary) ? ask.summary : '');
    const parts = splitUrl(url);
    // A tool with no URL is not a request line — a search query set as one
    // would invent a host that was never contacted.
    if (parts !== null) {
      return {
        kind: 'fetch',
        header: {
          language: 'network',
          context: '',
          blast: parts.scheme === 'http://' ? 'unencrypted request' : null,
          counts: null,
        },
        method: str(input, 'method').toUpperCase() || 'GET',
        ...parts,
      };
    }
  }

  if (EDIT_TOOLS.includes(ask.toolName)) {
    const path = str(input, 'file_path') || str(input, 'notebook_path');
    const hunks = editHunks(ask.toolName, input);
    if (path !== '' && hunks.length > 0) {
      const added = hunks.reduce((n, h) => n + h.added.length, 0);
      const removed = hunks.reduce((n, h) => n + h.removed.length, 0);
      return {
        kind: 'diff',
        header: { language: fileLanguage(path), context: path, blast: null, counts: { added, removed } },
        rows: diffRows(hunks),
      };
    }
  }

  return {
    kind: 'plain',
    header: { language: ask.toolName.toLowerCase() || 'tool', context: ask.cwd, blast: null, counts: null },
    // Never empty: a tool that exposes no one-liner still states its own name,
    // so the surface is never a blank box asking for a decision.
    text: ask.summary || ask.toolName || 'tool',
  };
}

function editHunks(toolName: string, input: Record<string, unknown>): Hunk[] {
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => hunkOf(str(e, 'old_string'), str(e, 'new_string')))
      .filter((h) => h.removed.length > 0 || h.added.length > 0);
  }
  // A Write is an edit with no old side: every line is an addition.
  const oldText = toolName === 'Write' ? '' : str(input, 'old_string');
  const newText = toolName === 'Write' ? str(input, 'content') : str(input, 'new_string');
  if (oldText === '' && newText === '') return [];
  const h = hunkOf(oldText, newText);
  return h.removed.length > 0 || h.added.length > 0 ? [h] : [];
}

function splitUrl(url: string): { scheme: string; host: string; path: string } | null {
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/.exec(url);
  if (m === null) return null;
  return { scheme: m[1]!, host: m[2]!, path: m[3]! };
}

/**
 * 9b: the legend qualifies what kind of ask this is — `Permission · edit`. A
 * command stays bare `Permission`: it is the default ask, and naming it would
 * add a word that distinguishes nothing.
 */
export function cardLegend(surface: CodeSurface): string {
  switch (surface.kind) {
    case 'command':
      return 'Permission';
    case 'diff':
      return 'Permission · edit';
    case 'fetch':
      return 'Permission · fetch';
    default:
      return `Permission · ${surface.header.language}`;
  }
}

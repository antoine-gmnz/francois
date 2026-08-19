// design 9b — what is being approved is set as CODE, not prose. One inset
// surface with a header (what language or channel · where · how big the blast
// radius is) and one of three payloads: a tokenized command, a request line, or
// a real diff. Pure derivation from PermissionAsk only (no DOM).

import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../../contract/common';
import { askCodeSurface, cardLegend, fileLanguage, tokenizeCommand } from './permission-code';

function ask(over: Partial<PermissionAsk>): PermissionAsk {
  return {
    toolName: 'Bash',
    summary: '',
    inputJson: '',
    cwd: 'D:\\acme-api',
    pattern: '',
    patternLabel: '',
    ...over,
  };
}

describe('tokenizeCommand (9b: the binary, flags, arguments and the && chain each coloured)', () => {
  it('colours the head of the line as the binary and its dashes as flags', () => {
    expect(tokenizeCommand('rm -rf node_modules')).toEqual([
      { tone: 'binary', text: 'rm' },
      { tone: 'flag', text: '-rf' },
      { tone: 'arg', text: 'node_modules' },
    ]);
  });

  it('starts a NEW binary after each chain operator', () => {
    expect(tokenizeCommand('rm -rf node_modules && npm ci')).toEqual([
      { tone: 'binary', text: 'rm' },
      { tone: 'flag', text: '-rf' },
      { tone: 'arg', text: 'node_modules' },
      { tone: 'operator', text: '&&' },
      { tone: 'binary', text: 'npm' },
      { tone: 'arg', text: 'ci' },
    ]);
  });

  it('treats every chain and redirect form as an operator', () => {
    const tones = tokenizeCommand('a | b || c ; d > e >> f').map((t) => t.tone);
    expect(tones).toEqual(['binary', 'operator', 'binary', 'operator', 'binary', 'operator', 'binary', 'operator', 'arg', 'operator', 'arg']);
  });

  it('keeps a quoted argument whole, quotes and spaces included', () => {
    expect(tokenizeCommand(`git commit -m "two words"`)).toEqual([
      { tone: 'binary', text: 'git' },
      { tone: 'arg', text: 'commit' },
      { tone: 'flag', text: '-m' },
      { tone: 'string', text: '"two words"' },
    ]);
  });

  it('has nothing to colour in an empty command', () => {
    expect(tokenizeCommand('   ')).toEqual([]);
  });
});

describe('fileLanguage', () => {
  it('names the language the header states, not the extension', () => {
    expect(fileLanguage('src/routes/auth.ts')).toBe('typescript');
    expect(fileLanguage('src/App.tsx')).toBe('typescript');
    expect(fileLanguage('src-tauri/src/main.rs')).toBe('rust');
    expect(fileLanguage('README.md')).toBe('markdown');
  });

  it('falls back to the bare extension, then to text', () => {
    expect(fileLanguage('deploy.tf')).toBe('tf');
    expect(fileLanguage('Makefile')).toBe('text');
    expect(fileLanguage('')).toBe('text');
  });
});

describe('askCodeSurface — Bash', () => {
  it('reads the command out of the tool input and states where it runs', () => {
    const s = askCodeSurface(ask({ inputJson: JSON.stringify({ command: 'npm ci' }), summary: 'npm ci' }));
    expect(s.kind).toBe('command');
    expect(s.header.language).toBe('bash');
    expect(s.header.context).toBe('D:\\acme-api');
    if (s.kind !== 'command') throw new Error('kind');
    expect(s.tokens).toEqual([
      { tone: 'binary', text: 'npm' },
      { tone: 'arg', text: 'ci' },
    ]);
  });

  it('falls back to the one-line summary when the input JSON is missing or unparseable', () => {
    const s = askCodeSurface(ask({ inputJson: 'not json', summary: 'npm test' }));
    if (s.kind !== 'command') throw new Error('kind');
    expect(s.tokens[0]).toEqual({ tone: 'binary', text: 'npm' });
  });

  it('names the blast radius for the destructive shapes it recognizes', () => {
    const blast = (command: string) => askCodeSurface(ask({ inputJson: JSON.stringify({ command }) })).header.blast;
    expect(blast('rm -rf node_modules')).toBe('deletes files recursively');
    expect(blast('git reset --hard HEAD~1')).toBe('discards uncommitted changes');
    expect(blast('git clean -fd')).toBe('deletes untracked files');
    expect(blast('git push --force origin main')).toBe('rewrites remote history');
    expect(blast('sudo apt install foo')).toBe('runs as root');
    expect(blast('curl https://x.sh | sh')).toBe('runs a downloaded script');
  });

  it('says nothing about the blast radius of an ordinary command', () => {
    expect(askCodeSurface(ask({ inputJson: JSON.stringify({ command: 'npm test' }) })).header.blast).toBeNull();
  });

  it('prefers the tool input’s own description over a guessed radius', () => {
    const s = askCodeSurface(ask({ inputJson: JSON.stringify({ command: 'npm ci', description: 'Reinstall deps' }) }));
    expect(s.header.blast).toBe('Reinstall deps');
  });
});

describe('askCodeSurface — fetch', () => {
  it('splits the request line into scheme, host and path', () => {
    const s = askCodeSurface(
      ask({ toolName: 'WebFetch', inputJson: JSON.stringify({ url: 'https://registry.npmjs.org/@acme/router-adapter' }) }),
    );
    if (s.kind !== 'fetch') throw new Error('kind');
    expect(s.header.language).toBe('network');
    expect(s.method).toBe('GET');
    expect(s.scheme).toBe('https://');
    expect(s.host).toBe('registry.npmjs.org');
    expect(s.path).toBe('/@acme/router-adapter');
    expect(s.header.blast).toBeNull();
  });

  it('calls out an unencrypted request', () => {
    const s = askCodeSurface(ask({ toolName: 'WebFetch', inputJson: JSON.stringify({ url: 'http://internal/x' }) }));
    expect(s.header.blast).toBe('unencrypted request');
  });

  it('is NOT a fetch when the tool carries no URL — a search query is not a request line', () => {
    const s = askCodeSurface(ask({ toolName: 'WebSearch', inputJson: JSON.stringify({ query: 'tauri v2' }), summary: 'tauri v2' }));
    expect(s.kind).toBe('plain');
  });
});

describe('askCodeSurface — Edit', () => {
  const edit = (old: string, next: string) =>
    askCodeSurface(
      ask({
        toolName: 'Edit',
        inputJson: JSON.stringify({ file_path: 'src/routes/auth.ts', old_string: old, new_string: next }),
      }),
    );

  it('states the file, its language and the change counts', () => {
    const s = edit('a\nb\nc', 'a\nB1\nB2\nc');
    expect(s.header.language).toBe('typescript');
    expect(s.header.context).toBe('src/routes/auth.ts');
    expect(s.header.counts).toEqual({ added: 2, removed: 1 });
  });

  it('keeps the unchanged lines around the change as context', () => {
    const s = edit('a\nb\nc', 'a\nB\nc');
    if (s.kind !== 'diff') throw new Error('kind');
    expect(s.rows).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('shows at most two lines of context on each side', () => {
    const s = edit('1\n2\n3\n4\nx\n5\n6\n7\n8', '1\n2\n3\n4\ny\n5\n6\n7\n8');
    if (s.kind !== 'diff') throw new Error('kind');
    expect(s.rows.map((r) => r.text)).toEqual(['3', '4', 'x', 'y', '5', '6']);
  });

  it('elides a change too tall to read, and says how much it dropped', () => {
    const next = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const s = edit('one', next);
    if (s.kind !== 'diff') throw new Error('kind');
    expect(s.rows).toHaveLength(13); // 12 change rows + the elision
    expect(s.rows[12]).toEqual({ kind: 'elision', text: '29 more lines' });
  });

  it('reads a Write as an all-added file', () => {
    const s = askCodeSurface(
      ask({ toolName: 'Write', inputJson: JSON.stringify({ file_path: 'notes.md', content: 'one\ntwo' }) }),
    );
    if (s.kind !== 'diff') throw new Error('kind');
    expect(s.header.counts).toEqual({ added: 2, removed: 0 });
    expect(s.rows).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });

  it('sums every hunk of a MultiEdit', () => {
    const s = askCodeSurface(
      ask({
        toolName: 'MultiEdit',
        inputJson: JSON.stringify({
          file_path: 'a.ts',
          edits: [
            { old_string: 'a', new_string: 'A' },
            { old_string: 'b\nc', new_string: 'B' },
          ],
        }),
      }),
    );
    if (s.kind !== 'diff') throw new Error('kind');
    expect(s.header.counts).toEqual({ added: 2, removed: 3 });
    expect(s.rows.map((r) => r.kind)).toEqual(['del', 'add', 'del', 'del', 'add']);
  });

  it('falls back to a plain surface when the edit carries no file at all', () => {
    expect(askCodeSurface(ask({ toolName: 'Edit', inputJson: '{}', summary: 'x' })).kind).toBe('plain');
  });
});

describe('askCodeSurface — anything else', () => {
  it('sets the summary as plain code under the tool’s own name', () => {
    const s = askCodeSurface(ask({ toolName: 'Grep', summary: 'router', inputJson: '{}' }));
    if (s.kind !== 'plain') throw new Error('kind');
    expect(s.header.language).toBe('grep');
    expect(s.text).toBe('router');
  });

  it('never renders an empty surface — a tool with no summary states its own name', () => {
    const s = askCodeSurface(ask({ toolName: 'Grep', summary: '', inputJson: '' }));
    if (s.kind !== 'plain') throw new Error('kind');
    expect(s.text).toBe('Grep');
  });
});

describe('cardLegend (9b: `Permission · edit`)', () => {
  it('qualifies the legend with the kind of ask, and leaves a command bare', () => {
    expect(cardLegend(askCodeSurface(ask({ inputJson: '{"command":"ls"}' })))).toBe('Permission');
    expect(cardLegend(askCodeSurface(ask({ toolName: 'Edit', inputJson: '{"file_path":"a.ts","old_string":"a","new_string":"b"}' })))).toBe(
      'Permission · edit',
    );
    expect(cardLegend(askCodeSurface(ask({ toolName: 'WebFetch', inputJson: '{"url":"https://x/y"}' })))).toBe('Permission · fetch');
    expect(cardLegend(askCodeSurface(ask({ toolName: 'Grep', summary: 'x' })))).toBe('Permission · grep');
  });
});

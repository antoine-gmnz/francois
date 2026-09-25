import { describe, expect, it } from 'vitest';
import { claudeEditDiffLines, highlightJson, highlightShell, isUnifiedDiff, tokenizeUnifiedDiff, type SyntaxToken } from './step-syntax';

const join = (tokens: SyntaxToken[]) => tokens.map((t) => t.text).join('');
const tones = (tokens: SyntaxToken[]) => tokens.filter((t) => t.text.trim() !== '').map((t) => [t.tone, t.text]);

describe('highlightShell', () => {
  it('is lossless — every character survives, whitespace and newlines included', () => {
    const src = "cat <<'EOF' > out.txt\n  indented   line\nEOF\nnpm test \\\n  --reporter=dot  # quiet";
    expect(join(highlightShell(src))).toBe(src);
  });

  it('colours the program, its flags, strings, and the chain operators', () => {
    expect(tones(highlightShell('git commit -m "fix: x" && npm run build'))).toEqual([
      ['command', 'git'],
      ['plain', 'commit'],
      ['flag', '-m'],
      ['string', '"fix: x"'],
      ['operator', '&&'],
      ['command', 'npm'],
      ['plain', 'run'],
      ['plain', 'build'],
    ]);
  });

  it('re-arms the command after a pipe, but not after a redirect', () => {
    expect(tones(highlightShell('ls -la | grep foo > out.txt 2>&1'))).toEqual([
      ['command', 'ls'],
      ['flag', '-la'],
      ['operator', '|'],
      ['command', 'grep'],
      ['plain', 'foo'],
      ['operator', '>'],
      ['plain', 'out.txt'],
      ['operator', '2>&1'],
    ]);
  });

  it('reads variables, env prefixes and comments', () => {
    expect(tones(highlightShell('FOO=1 echo $HOME ${BAR} # done'))).toEqual([
      ['variable', 'FOO'],
      ['operator', '='],
      ['plain', '1'],
      ['command', 'echo'],
      ['variable', '$HOME'],
      ['variable', '${BAR}'],
      ['comment', '# done'],
    ]);
  });

  it('handles PowerShell cmdlets, parameters and $env: variables', () => {
    expect(tones(highlightShell('Get-ChildItem -Path $env:TEMP | Select-Object -First 5'))).toEqual([
      ['command', 'Get-ChildItem'],
      ['flag', '-Path'],
      ['variable', '$env:TEMP'],
      ['operator', '|'],
      ['command', 'Select-Object'],
      ['flag', '-First'],
      ['number', '5'],
    ]);
  });

  it('starts a new command on each line, but not across a continuation', () => {
    const t = tones(highlightShell('cd src\nnpm test \\\n  run'));
    expect(t).toContainEqual(['command', 'npm']);
    expect(t).toContainEqual(['plain', 'run']);
  });

  it('treats shell keywords as keywords and the word after them as a command', () => {
    expect(tones(highlightShell('if true; then echo hi; fi'))).toEqual([
      ['keyword', 'if'],
      ['command', 'true'],
      ['operator', ';'],
      ['keyword', 'then'],
      ['command', 'echo'],
      ['plain', 'hi'],
      ['operator', ';'],
      ['keyword', 'fi'],
    ]);
  });

  it('keeps a `#` inside a word as part of the word', () => {
    expect(tones(highlightShell('echo a#b'))).toEqual([
      ['command', 'echo'],
      ['plain', 'a#b'],
    ]);
  });

  it('survives an unterminated quote', () => {
    const src = 'echo "never closed';
    expect(join(highlightShell(src))).toBe(src);
  });
});

describe('highlightJson', () => {
  it('is lossless and tells keys from string values', () => {
    const src = '{\n  "pattern": "*.ts",\n  "limit": 20,\n  "all": true,\n  "x": null\n}';
    const tokens = highlightJson(src);
    expect(join(tokens)).toBe(src);
    expect(tones(tokens)).toEqual([
      ['punct', '{'],
      ['key', '"pattern"'],
      ['punct', ':'],
      ['string', '"*.ts"'],
      ['punct', ','],
      ['key', '"limit"'],
      ['punct', ':'],
      ['number', '20'],
      ['punct', ','],
      ['key', '"all"'],
      ['punct', ':'],
      ['literal', 'true'],
      ['punct', ','],
      ['key', '"x"'],
      ['punct', ':'],
      ['literal', 'null'],
      ['punct', '}'],
    ]);
  });

  it('keeps escaped quotes inside a string', () => {
    const tokens = highlightJson('{"a": "say \\"hi\\""}');
    expect(tokens).toContainEqual({ tone: 'string', text: '"say \\"hi\\""' });
  });
});

describe('isUnifiedDiff', () => {
  it('recognises a `diff --git` header', () => {
    const src = 'diff --git a/foo.ts b/foo.ts\nindex abc..def 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n';
    expect(isUnifiedDiff(src)).toBe(true);
  });

  it('recognises a bare `---`/`+++`/`@@` unified diff with no `diff --git` line', () => {
    const src = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line two edited\n line three';
    expect(isUnifiedDiff(src)).toBe(true);
  });

  it('rejects a markdown bullet list starting with `- item`', () => {
    const src = '- item one\n- item two\n- item three';
    expect(isUnifiedDiff(src)).toBe(false);
  });

  it('rejects JSON output whose first line happens to start with `-`', () => {
    const src = '-1\n{"error": "negative"}';
    expect(isUnifiedDiff(src)).toBe(false);
  });

  it('rejects shell output starting with a `--- ` line but with no `+++`/hunk header', () => {
    const src = '--- starting server ---\nlistening on port 3000';
    expect(isUnifiedDiff(src)).toBe(false);
  });

  it('rejects empty output', () => {
    expect(isUnifiedDiff('')).toBe(false);
  });
});

describe('tokenizeUnifiedDiff', () => {
  it('classifies file headers, the hunk header, and +/-/context lines', () => {
    const src = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line two edited\n line three';
    expect(tokenizeUnifiedDiff(src)).toEqual([
      { kind: 'header', text: 'diff --git a/foo.ts b/foo.ts' },
      { kind: 'header', text: '--- a/foo.ts' },
      { kind: 'header', text: '+++ b/foo.ts' },
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: ' line one' },
      { kind: 'remove', text: '-line two' },
      { kind: 'add', text: '+line two edited' },
      { kind: 'context', text: ' line three' },
    ]);
  });

  it('is lossless — joining the tokenized lines back with \\n reproduces the input', () => {
    const src = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b';
    expect(
      tokenizeUnifiedDiff(src)
        .map((l) => l.text)
        .join('\n'),
    ).toBe(src);
  });
});

describe('claudeEditDiffLines', () => {
  it('builds a diff from an Edit\'s old_string/new_string, headed by the file path', () => {
    const lines = claudeEditDiffLines(
      'Edit',
      JSON.stringify({ file_path: 'src/routes/auth.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }),
    );
    expect(lines).toEqual([
      { kind: 'header', text: 'src/routes/auth.ts' },
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('reads a Write as an all-added file', () => {
    const lines = claudeEditDiffLines('Write', JSON.stringify({ file_path: 'notes.md', content: 'one\ntwo' }));
    expect(lines).toEqual([
      { kind: 'header', text: 'notes.md' },
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });

  it('sums every hunk of a MultiEdit', () => {
    const lines = claudeEditDiffLines(
      'MultiEdit',
      JSON.stringify({
        file_path: 'a.ts',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b\nc', new_string: 'B' },
        ],
      }),
    );
    expect(lines?.[0]).toEqual({ kind: 'header', text: 'a.ts' });
    expect(lines?.map((l) => l.kind)).toEqual(['header', 'remove', 'add', 'remove', 'remove', 'add']);
  });

  it('turns a dropped-line elision into a header-styled row', () => {
    const next = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const lines = claudeEditDiffLines('Edit', JSON.stringify({ file_path: 'big.ts', old_string: 'one', new_string: next }));
    expect(lines?.[lines.length - 1]).toEqual({ kind: 'header', text: '29 more lines' });
  });

  it('is null for a tool this builder does not cover', () => {
    expect(claudeEditDiffLines('Bash', JSON.stringify({ command: 'ls' }))).toBeNull();
  });

  it('is null when the input has no file path or is unparseable', () => {
    expect(claudeEditDiffLines('Edit', 'not json')).toBeNull();
    expect(claudeEditDiffLines('Edit', JSON.stringify({ old_string: 'a', new_string: 'b' }))).toBeNull();
  });

  it('is null when the edit carries no actual change', () => {
    expect(claudeEditDiffLines('Edit', JSON.stringify({ file_path: 'a.ts' }))).toBeNull();
  });
});

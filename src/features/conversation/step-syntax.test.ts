import { describe, expect, it } from 'vitest';
import { highlightJson, highlightShell, type SyntaxToken } from './step-syntax';

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

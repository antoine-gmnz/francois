import { describe, expect, it } from 'vitest';
import { parseAnsi } from './ansi';

// Built from a char code rather than an escape so no editor, formatter or
// clipboard round-trip can quietly turn a real ESC byte into the four
// characters `\`, `u`, `0`... — which is exactly the bug this parser exists
// to render correctly.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const sgr = (params: string) => `${ESC}[${params}m`;

/** The rendered text, with every escape sequence resolved away. */
const plain = (input: string) =>
  parseAnsi(input)
    .map((s) => s.text)
    .join('');

describe('parseAnsi', () => {
  it('leaves text with no escape sequences unstyled, split only at its newlines', () => {
    expect(parseAnsi('npm test\n  ok')).toEqual([{ text: 'npm test\n', className: '' }, { text: '  ok', className: '' }]);
  });

  it('returns nothing at all for empty text', () => {
    expect(parseAnsi('')).toEqual([]);
  });

  it('turns a named foreground into its token class and closes it on reset', () => {
    const spans = parseAnsi(`${sgr('31')}FAIL${sgr('0')} rest`);
    expect(spans).toEqual([
      { text: 'FAIL', className: 'ansi-fg-red' },
      { text: ' rest', className: '' },
    ]);
  });

  it('maps 90-97 to the bright half and 39/49 back to the default', () => {
    expect(parseAnsi(`${sgr('90')}dim${sgr('39')}back`)).toEqual([
      { text: 'dim', className: 'ansi-fg-bright-black' },
      { text: 'back', className: '' },
    ]);
    expect(parseAnsi(`${sgr('42')}on${sgr('49')}off`)).toEqual([
      { text: 'on', className: 'ansi-bg-green' },
      { text: 'off', className: '' },
    ]);
  });

  it('brightens a bold 30-37 foreground, the way xterm does', () => {
    expect(parseAnsi(`${sgr('1;32')}pass`)).toEqual([{ text: 'pass', className: 'ansi-bold ansi-fg-bright-green' }]);
  });

  it('carries the attribute flags and drops them on their own reset codes', () => {
    expect(parseAnsi(`${sgr('2')}a${sgr('22')}b`)).toEqual([
      { text: 'a', className: 'ansi-dim' },
      { text: 'b', className: '' },
    ]);
    expect(parseAnsi(`${sgr('3;4')}a${sgr('23')}b${sgr('24')}c`)).toEqual([
      { text: 'a', className: 'ansi-italic ansi-underline' },
      { text: 'b', className: 'ansi-underline' },
      { text: 'c', className: '' },
    ]);
  });

  it('swaps foreground and background under inverse, and back on 27', () => {
    expect(parseAnsi(`${sgr('31;47;7')}x${sgr('27')}y`)).toEqual([
      { text: 'x', className: 'ansi-fg-white ansi-bg-red' },
      { text: 'y', className: 'ansi-fg-red ansi-bg-white' },
    ]);
  });

  it('resolves 256-colour and truecolour to a literal rgb() — no token names them', () => {
    expect(parseAnsi(`${sgr('38;5;196')}x`)).toEqual([{ text: 'x', className: '', color: 'rgb(255, 0, 0)' }]);
    expect(parseAnsi(`${sgr('38;5;244')}x`)).toEqual([{ text: 'x', className: '', color: 'rgb(128, 128, 128)' }]);
    expect(parseAnsi(`${sgr('48;2;10;20;30')}x`)).toEqual([{ text: 'x', className: '', background: 'rgb(10, 20, 30)' }]);
  });

  it('routes 38;5;n below 16 back onto the named classes', () => {
    expect(parseAnsi(`${sgr('38;5;9')}x`)).toEqual([{ text: 'x', className: 'ansi-fg-bright-red' }]);
  });

  it('treats a bare ESC[m as a reset', () => {
    expect(parseAnsi(`${sgr('31')}a${sgr('')}b`)).toEqual([
      { text: 'a', className: 'ansi-fg-red' },
      { text: 'b', className: '' },
    ]);
  });

  it('swallows a non-SGR CSI sequence without eating the text around it', () => {
    expect(plain(`before${ESC}[2Kafter${ESC}[1;1Hend`)).toBe('beforeafterend');
  });

  it('swallows an OSC sequence terminated by either BEL or ST', () => {
    expect(plain(`${ESC}]0;window title${BEL}shown`)).toBe('shown');
    expect(plain(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe('link');
  });

  it('drops a sequence the capture cut mid-way rather than printing its bytes', () => {
    expect(plain(`kept${ESC}[38;5`)).toBe('kept');
  });

  it('keeps tabs and newlines — they are the indentation, not control litter', () => {
    expect(plain('a\tb\n\t\tc')).toBe('a\tb\n\t\tc');
  });

  it('drops the control characters a terminal would never draw', () => {
    expect(plain(`a${String.fromCharCode(8)}b${String.fromCharCode(0)}c`)).toBe('abc');
  });

  it('never lets a span straddle a newline', () => {
    expect(parseAnsi(`${sgr('31')}one\ntwo`)).toEqual([
      { text: 'one\n', className: 'ansi-fg-red' },
      { text: 'two', className: 'ansi-fg-red' },
    ]);
  });

  it('drops the line a carriage return is about to overwrite, and only that line', () => {
    expect(plain('keep\n 10%\r 90%\rdone')).toBe('keep\ndone');
  });

  it('keeps every line of CRLF output — a CR that ends a line is a terminator, not a rewrite', () => {
    expect(plain('one\r\ntwo\r\nthree')).toBe('one\ntwo\nthree');
    expect(parseAnsi('one\r\ntwo')).toEqual([
      { text: 'one\n', className: '' },
      { text: 'two', className: '' },
    ]);
  });

  it('still reads a rewrite as a rewrite when the line ends CRLF', () => {
    expect(plain(' 10%\r 90%\r\ndone')).toBe(' 90%\ndone');
  });

  it('keeps the last line when the capture ends on a bare CR', () => {
    expect(plain('one\r\ntwo\r')).toBe('one\ntwo');
  });

  it('keeps styling in force across a carriage return', () => {
    expect(parseAnsi(`${sgr('32')}10%\r90%`)).toEqual([{ text: '90%', className: 'ansi-fg-green' }]);
  });
});

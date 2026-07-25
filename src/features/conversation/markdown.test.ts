import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from './markdown';

// Flatten an inline tree to its visible text, so assertions read cleanly.
function inlineText(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.value;
        case 'br':
          return '\n';
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}

describe('parseInline', () => {
  it('plain text is a single text node', () => {
    expect(parseInline('hello world')).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('bold and italic', () => {
    expect(parseInline('**bold**')).toEqual([{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }]);
    expect(parseInline('*it*')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'it' }] }]);
    expect(parseInline('__b__')).toEqual([{ type: 'strong', children: [{ type: 'text', value: 'b' }] }]);
  });

  it('nested emphasis inside strong', () => {
    const [node] = parseInline('**a *b* c**');
    expect(node.type).toBe('strong');
    expect(inlineText([node])).toBe('a b c');
    if (node.type === 'strong') expect(node.children.some((c) => c.type === 'em')).toBe(true);
  });

  it('inline code is verbatim and swallows markdown', () => {
    expect(parseInline('`a*b*c`')).toEqual([{ type: 'code', value: 'a*b*c' }]);
  });

  it('does not italicize snake_case identifiers', () => {
    expect(parseInline('call foo_bar_baz now')).toEqual([{ type: 'text', value: 'call foo_bar_baz now' }]);
  });

  it('strikethrough', () => {
    expect(parseInline('~~gone~~')).toEqual([{ type: 'del', children: [{ type: 'text', value: 'gone' }] }]);
  });

  it('links carry href + label', () => {
    expect(parseInline('[Anthropic](https://anthropic.com)')).toEqual([
      { type: 'link', href: 'https://anthropic.com', children: [{ type: 'text', value: 'Anthropic' }] },
    ]);
  });

  it('bare url autolinks without trailing punctuation', () => {
    expect(parseInline('see https://x.com.')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', href: 'https://x.com', children: [{ type: 'text', value: 'https://x.com' }] },
      { type: 'text', value: '.' },
    ]);
  });

  it('backslash escapes a literal asterisk', () => {
    expect(parseInline('a \\* b')).toEqual([{ type: 'text', value: 'a * b' }]);
  });

  it('an unclosed marker stays literal', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', value: '2 * 3 = 6' }]);
    expect(parseInline('use `code here')).toEqual([{ type: 'text', value: 'use `code here' }]);
  });
});

describe('parseMarkdown blocks', () => {
  it('headings by level', () => {
    const blocks = parseMarkdown('# H1\n## H2');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('a lone # with no space is a paragraph', () => {
    const [b] = parseMarkdown('#nospace');
    expect(b.type).toBe('paragraph');
  });

  it('paragraph keeps internal newlines as hard breaks', () => {
    const [b] = parseMarkdown('line one\nline two');
    expect(b.type).toBe('paragraph');
    if (b.type === 'paragraph') {
      expect(b.children.some((c) => c.type === 'br')).toBe(true);
      expect(inlineText(b.children)).toBe('line one\nline two');
    }
  });

  it('fenced code block preserves content and language', () => {
    const [b] = parseMarkdown('```ts\nconst x = 1;\n# not a heading\n```');
    expect(b).toEqual({ type: 'code', lang: 'ts', value: 'const x = 1;\n# not a heading' });
  });

  it('an unterminated fence (mid-stream) runs to the end', () => {
    const [b] = parseMarkdown('```\nstreaming...');
    expect(b).toEqual({ type: 'code', lang: null, value: 'streaming...' });
  });

  it('unordered list items', () => {
    const [b] = parseMarkdown('- one\n- two\n- three');
    expect(b.type).toBe('list');
    if (b.type === 'list') {
      expect(b.ordered).toBe(false);
      expect(b.items).toHaveLength(3);
      expect(inlineText((b.items[0][0] as Extract<MdBlock, { type: 'paragraph' }>).children)).toBe('one');
    }
  });

  it('ordered list keeps its start number', () => {
    const [b] = parseMarkdown('3. c\n4. d');
    expect(b).toMatchObject({ type: 'list', ordered: true, start: 3 });
    if (b.type === 'list') expect(b.items).toHaveLength(2);
  });

  it('nested list folds under its parent item', () => {
    const [b] = parseMarkdown('- parent\n  - child\n- sibling');
    expect(b.type).toBe('list');
    if (b.type === 'list') {
      expect(b.items).toHaveLength(2);
      const nested = b.items[0].find((x) => x.type === 'list');
      expect(nested).toBeDefined();
    }
  });

  it('blockquote parses its inner blocks', () => {
    const [b] = parseMarkdown('> quoted **text**');
    expect(b.type).toBe('blockquote');
    if (b.type === 'blockquote') {
      expect(b.children[0].type).toBe('paragraph');
      expect(inlineText((b.children[0] as Extract<MdBlock, { type: 'paragraph' }>).children)).toBe('quoted text');
    }
  });

  it('thematic break', () => {
    expect(parseMarkdown('---')[0]).toEqual({ type: 'hr' });
    expect(parseMarkdown('***')[0]).toEqual({ type: 'hr' });
  });

  it('GFM table with alignment', () => {
    const [b] = parseMarkdown('| a | b |\n| :--- | ---: |\n| 1 | 2 |');
    expect(b.type).toBe('table');
    if (b.type === 'table') {
      expect(b.align).toEqual(['left', 'right']);
      expect(b.header.map(inlineText)).toEqual(['a', 'b']);
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0].map(inlineText)).toEqual(['1', '2']);
    }
  });

  it('separates blocks split by blank lines', () => {
    const blocks = parseMarkdown('para one\n\n# heading\n\npara two');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
  });

  it('mixed document: heading, prose, code, list', () => {
    const md = ['# Title', '', 'Some **bold** prose.', '', '```', 'code()', '```', '', '- a', '- b'].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'code', 'list']);
  });

  it('empty input yields no blocks', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

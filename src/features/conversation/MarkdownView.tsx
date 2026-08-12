import { useMemo } from 'react';
import { parseMarkdown, type MdBlock, type MdInline, type TableAlign } from './markdown';
import './conversation.css';

// Renders the Markdown AST with the terminal palette. The whole app is set in
// JetBrains Mono, so code is set apart by a panel/background rather than a font
// switch. Links are shown styled but do NOT navigate the webview (no opener
// plugin is wired) — the full URL rides in the title tooltip.

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <span key={i}>{n.value}</span>;
          case 'br':
            return <br key={i} />;
          case 'strong':
            return (
              <strong key={i} className="md-strong">
                <Inline nodes={n.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i} className="md-em">
                <Inline nodes={n.children} />
              </em>
            );
          case 'del':
            return (
              <span key={i} className="md-del">
                <Inline nodes={n.children} />
              </span>
            );
          case 'code':
            return (
              <code key={i} className="md-code">
                {n.value}
              </code>
            );
          case 'link':
            return (
              // Non-navigating on purpose (no opener plugin) — the URL is in the tooltip.
              <a key={i} href={n.href} title={n.href} onClick={(e) => e.preventDefault()} className="md-link">
                <Inline nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

const HEADING_SIZE: Record<number, number> = { 1: 15, 2: 14, 3: 13.5, 4: 13, 5: 12.5, 6: 12.5 };

function BlockView({ block, first }: { block: MdBlock; first: boolean }) {
  const mt = first ? 0 : 8;
  switch (block.type) {
    case 'heading':
      return (
        <div
          className="md-heading"
          style={{
            marginTop: first ? 0 : 12,
            fontSize: HEADING_SIZE[block.level] ?? 12.5,
            letterSpacing: block.level <= 2 ? '0.01em' : undefined,
          }}
        >
          <Inline nodes={block.children} />
        </div>
      );
    case 'paragraph':
      return (
        <div style={{ marginTop: mt }}>
          <Inline nodes={block.children} />
        </div>
      );
    case 'code':
      return (
        <div className="md-code-wrap" style={{ marginTop: mt }}>
          {block.lang && <div className="md-lang-tag">{block.lang}</div>}
          <pre className="md-code-block">
            <code>{block.value}</code>
          </pre>
        </div>
      );
    case 'hr':
      return <div className="md-hr" style={{ marginTop: mt }} />;
    case 'blockquote':
      return (
        <div className="md-blockquote" style={{ marginTop: mt }}>
          <Blocks blocks={block.children} />
        </div>
      );
    case 'list':
      return <ListView block={block} mt={mt} />;
    case 'table':
      return <TableView block={block} mt={mt} />;
  }
}

function ListView({ block, mt }: { block: Extract<MdBlock, { type: 'list' }>; mt: number }) {
  const itemNodes = block.items.map((item, i) => (
    <li key={i} className="md-list-item">
      <Blocks blocks={item} tight />
    </li>
  ));
  return block.ordered ? (
    <ol start={block.start} className="md-list" style={{ marginTop: mt }}>
      {itemNodes}
    </ol>
  ) : (
    <ul className="md-list" style={{ marginTop: mt }}>
      {itemNodes}
    </ul>
  );
}

function align(a: TableAlign): 'left' | 'right' | 'center' {
  return a ?? 'left';
}

function TableView({ block, mt }: { block: Extract<MdBlock, { type: 'table' }>; mt: number }) {
  return (
    <div className="md-table-wrap" style={{ marginTop: mt }}>
      <table className="md-table">
        <thead>
          <tr>
            {block.header.map((h, i) => (
              <th key={i} className="md-cell md-cell--header" style={{ textAlign: align(block.align[i]) }}>
                <Inline nodes={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i} className="md-cell" style={{ textAlign: align(block.align[i]) }}>
                  <Inline nodes={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `tight` renders a single-paragraph block inline (no wrapper margin) so list
// items don't get paragraph spacing.
function Blocks({ blocks, tight }: { blocks: MdBlock[]; tight?: boolean }) {
  if (tight && blocks.length === 1 && blocks[0].type === 'paragraph') {
    return <Inline nodes={blocks[0].children} />;
  }
  return (
    <>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} first={i === 0} />
      ))}
    </>
  );
}

// The reading body is styled entirely by `.md-root` (and `--streaming`, the
// brighter tone a live reply carries) — never by an inline color. Assistant text
// is mostly bare `text` nodes with no class of their own, so whatever color sits
// on the root is what the whole reply inherits; an inline one would outrank every
// theme rule and leave the light theme reading dark-palette gray on white.
export default function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={streaming ? 'md-root md-root--streaming' : 'md-root'}>
      <Blocks blocks={blocks} />
    </div>
  );
}

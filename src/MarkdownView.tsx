import { useMemo } from 'react';
import { parseMarkdown, type MdBlock, type MdInline, type TableAlign } from './markdown';

// Renders the Markdown AST with the terminal palette. The whole app is set in
// JetBrains Mono, so code is set apart by a panel/background rather than a font
// switch. Links are shown styled but do NOT navigate the webview (no opener
// plugin is wired) — the full URL rides in the title tooltip.

const M = {
  accent: '#c8a15a',
  bright: '#dfe2e8',
  dim: '#868a93',
  faint: '#565a63',
  border: '#24262d',
  codeBg: '#16171c',
  codeBorder: '#24262d',
  inlineBg: '#20222a',
  inlineFg: '#d8b878',
  quoteBar: '#3a3d45',
  langTag: '#6b7079',
};

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
              <strong key={i} style={{ fontWeight: 700, color: M.bright }}>
                <Inline nodes={n.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i} style={{ fontStyle: 'italic' }}>
                <Inline nodes={n.children} />
              </em>
            );
          case 'del':
            return (
              <span key={i} style={{ textDecoration: 'line-through', color: M.dim }}>
                <Inline nodes={n.children} />
              </span>
            );
          case 'code':
            return (
              <code
                key={i}
                style={{ background: M.inlineBg, color: M.inlineFg, borderRadius: 3, padding: '0.5px 4px', fontSize: '0.92em' }}
              >
                {n.value}
              </code>
            );
          case 'link':
            return (
              // Non-navigating on purpose (no opener plugin) — the URL is in the tooltip.
              <a
                key={i}
                href={n.href}
                title={n.href}
                onClick={(e) => e.preventDefault()}
                style={{ color: M.accent, textDecoration: 'underline', cursor: 'pointer' }}
              >
                <Inline nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

const HEADING_SIZE: Record<number, number> = { 1: 15, 2: 14, 3: 13.5, 4: 13, 5: 12.5, 6: 12.5 };

function BlockView({ b, first }: { b: MdBlock; first: boolean }) {
  const mt = first ? 0 : 8;
  switch (b.type) {
    case 'heading':
      return (
        <div style={{ marginTop: first ? 0 : 12, marginBottom: 2, fontSize: HEADING_SIZE[b.level] ?? 12.5, fontWeight: 700, color: M.bright, letterSpacing: b.level <= 2 ? '0.01em' : undefined }}>
          <Inline nodes={b.children} />
        </div>
      );
    case 'paragraph':
      return (
        <div style={{ marginTop: mt }}>
          <Inline nodes={b.children} />
        </div>
      );
    case 'code':
      return (
        <div style={{ marginTop: mt, position: 'relative' }}>
          {b.lang && (
            <div style={{ position: 'absolute', top: 4, right: 8, fontSize: 9.5, letterSpacing: '0.04em', color: M.langTag, userSelect: 'none' }}>{b.lang}</div>
          )}
          <pre
            style={{
              margin: 0,
              background: M.codeBg,
              border: `1px solid ${M.codeBorder}`,
              borderRadius: 6,
              padding: '8px 10px',
              overflowX: 'auto',
              fontSize: 12,
              lineHeight: 1.5,
              color: M.bright,
            }}
          >
            <code>{b.value}</code>
          </pre>
        </div>
      );
    case 'hr':
      return <div style={{ marginTop: mt, marginBottom: 4, borderTop: `1px solid ${M.border}` }} />;
    case 'blockquote':
      return (
        <div style={{ marginTop: mt, borderLeft: `2px solid ${M.quoteBar}`, paddingLeft: 10, color: M.dim }}>
          <Blocks blocks={b.children} />
        </div>
      );
    case 'list':
      return <ListView b={b} mt={mt} />;
    case 'table':
      return <TableView b={b} mt={mt} />;
  }
}

function ListView({ b, mt }: { b: Extract<MdBlock, { type: 'list' }>; mt: number }) {
  const style = { marginTop: mt, marginBottom: 0, paddingLeft: 20 } as const;
  const itemNodes = b.items.map((item, i) => (
    <li key={i} style={{ margin: '1px 0' }}>
      <Blocks blocks={item} tight />
    </li>
  ));
  return b.ordered ? (
    <ol start={b.start} style={style}>
      {itemNodes}
    </ol>
  ) : (
    <ul style={style}>{itemNodes}</ul>
  );
}

function align(a: TableAlign): 'left' | 'right' | 'center' {
  return a ?? 'left';
}

function TableView({ b, mt }: { b: Extract<MdBlock, { type: 'table' }>; mt: number }) {
  const cell = (extra?: React.CSSProperties): React.CSSProperties => ({
    border: `1px solid ${M.border}`,
    padding: '3px 8px',
    ...extra,
  });
  return (
    <div style={{ marginTop: mt, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {b.header.map((h, i) => (
              <th key={i} style={cell({ textAlign: align(b.align[i]), fontWeight: 700, color: M.bright, background: '#1b1d23' })}>
                <Inline nodes={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i} style={cell({ textAlign: align(b.align[i]) })}>
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
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} first={i === 0} />
      ))}
    </>
  );
}

export default function Markdown({ text, color }: { text: string; color: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div style={{ color, fontSize: 12.5, lineHeight: 1.55, wordBreak: 'break-word' }}>
      <Blocks blocks={blocks} />
    </div>
  );
}

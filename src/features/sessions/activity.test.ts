import { describe, expect, it } from 'vitest';
import { activityLabel } from './activity';

describe('activityLabel', () => {
  it('shortens a file tool to the leaf, the mock\'s "editing UsageBar.tsx"', () => {
    expect(activityLabel('Edit', 'src/features/usage/UsageBar.tsx')).toBe('editing UsageBar.tsx');
    expect(activityLabel('Read', 'D:\\repo\\src\\main.tsx')).toBe('reading main.tsx');
    expect(activityLabel('Write', '/tmp/out.json')).toBe('writing out.json');
  });

  it('leaves a NON-path summary alone — a command is not a path', () => {
    expect(activityLabel('Bash', 'npm test -- --reporter=dot')).toBe('running npm test -- --reporter=dot');
    expect(activityLabel('Grep', 'STATUS_COLOR')).toBe('searching STATUS_COLOR');
  });

  it('flattens whitespace so a heredoc cannot grow the row', () => {
    expect(activityLabel('Bash', 'git commit -m "one\n  two"')).toBe('running git commit -m "one two"');
  });

  it('truncates a long summary with an ellipsis', () => {
    const label = activityLabel('Bash', 'x'.repeat(200));
    expect(label.startsWith('running ')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('running '.length + 64);
    expect(label.endsWith('…')).toBe(true);
  });

  it('falls back to the tool name lowercased for an unknown tool', () => {
    expect(activityLabel('SomeMcpTool', '')).toBe('somemcptool');
    expect(activityLabel('SomeMcpTool', 'thing')).toBe('somemcptool thing');
  });

  it('is the bare verb when the summary is empty or blank', () => {
    expect(activityLabel('Read', '')).toBe('reading');
    expect(activityLabel('Read', '   ')).toBe('reading');
  });

  it('returns nothing at all for a nameless tool', () => {
    expect(activityLabel('', 'whatever')).toBe('');
  });
});

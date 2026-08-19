import { describe, it, expect } from 'vitest';
import {
  FRANCOIS_TOOLS,
  OPENAI_CONTEXT_DEFAULT,
  OPENAI_CONTEXT_FALLBACK,
  contextTokensFor,
} from './multi-provider-openai';
import type { FrancoisToolName } from './multi-provider-openai';

// Written out rather than derived from FRANCOIS_TOOLS — a test that reads its
// members back off the thing under test would pass no matter which one went
// missing. The Rust side asserts against this same list (§5), so a tool renamed
// on one side fails on the other.
const TOOLS: FrancoisToolName[] = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'];

describe('FRANCOIS_TOOLS', () => {
  it('is exactly the six tools, in order', () => {
    expect([...FRANCOIS_TOOLS]).toEqual(TOOLS);
  });

  // The whole reason the names are not `read_file`/`run_command`: a rule written
  // on a Claude session must read identically here (FR-11, §5).
  it('carries Claude Code names verbatim', () => {
    for (const tool of FRANCOIS_TOOLS) {
      expect(tool).toBe(tool[0].toUpperCase() + tool.slice(1));
      expect(tool).not.toMatch(/[_-]/);
    }
  });
});

describe('contextTokensFor', () => {
  it('matches a prefix from the table', () => {
    expect(contextTokensFor('gpt-4o')).toBe(128_000);
    expect(contextTokensFor('gpt-4o-mini-2024-07-18')).toBe(128_000);
    expect(contextTokensFor('o3-mini')).toBe(200_000);
  });

  it('falls back to 128k when nothing matches', () => {
    expect(contextTokensFor('llama-3.1-70b')).toBe(OPENAI_CONTEXT_DEFAULT);
    expect(contextTokensFor('')).toBe(OPENAI_CONTEXT_DEFAULT);
  });

  // The table is data, not a priority list: `gpt-4.1` must win over a shorter
  // `gpt-4`-shaped entry whatever order they sit in.
  it('takes the longest matching prefix', () => {
    expect(contextTokensFor('gpt-4.1-mini')).toBe(1_047_576);
    expect(contextTokensFor('gpt-5-turbo')).toBe(400_000);
  });

  it('has no duplicate prefixes in the table', () => {
    const prefixes = OPENAI_CONTEXT_FALLBACK.map((e) => e.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

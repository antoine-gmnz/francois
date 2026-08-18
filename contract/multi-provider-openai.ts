// contract/multi-provider-openai.ts — the Francois-loop tool vocabulary and the
// context-window fallback table. Pure, no IPC — same idiom as
// runtimeCapabilities in multi-provider-seam.ts and MODEL_CATALOG_FALLBACK.
// Authored from specs/multi-provider-openai.md §5.
//
// This feature adds NO channel, NO command and NO SessionEvent member: the seam
// exists so the Francois runtime reuses every one of them unchanged.

/**
 * The tools the Francois agent loop exposes. These are Claude Code's tool names
 * VERBATIM and deliberately so: permission rules are one vocabulary, so a rule
 * written as `Bash(npm test:*)` from a Claude session reads identically here and
 * the rules editor never renders a second dialect.
 */
export type FrancoisToolName = 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob' | 'Bash';

export const FRANCOIS_TOOLS: readonly FrancoisToolName[] = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
] as const;

/**
 * Context windows by model-id prefix, longest prefix wins. /v1/models in the
 * OpenAI dialect carries no window, so this is the only source; real usage comes
 * from each response's `usage.prompt_tokens` (FR-7), which keeps the meter honest
 * even when the limit is a guess.
 */
export const OPENAI_CONTEXT_FALLBACK: ReadonlyArray<{ prefix: string; contextTokens: number }> = [
  { prefix: 'gpt-5', contextTokens: 400_000 },
  { prefix: 'gpt-4.1', contextTokens: 1_047_576 },
  { prefix: 'gpt-4o', contextTokens: 128_000 },
  { prefix: 'o3', contextTokens: 200_000 },
  { prefix: 'o4', contextTokens: 200_000 },
];

/** Applied when no prefix matches. */
export const OPENAI_CONTEXT_DEFAULT = 128_000;

/**
 * Longest matching prefix wins, so `gpt-4.1` beats a hypothetical `gpt-4` entry
 * regardless of table order — the table is data, not a priority list.
 */
export function contextTokensFor(modelId: string): number {
  let best: { prefix: string; contextTokens: number } | undefined;
  for (const entry of OPENAI_CONTEXT_FALLBACK) {
    if (!modelId.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best ? best.contextTokens : OPENAI_CONTEXT_DEFAULT;
}

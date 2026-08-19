// Shared "this pane's session record, or null" selector (multi-provider-openai
// review round 2: the exact same line was hand-rolled in AgentsPanel, McpPanel,
// SkillsPanel, WorkflowsPanel — all four newly added for the `sessionCapability`
// lookup — and pre-existed in ConversationView). One selector, one place to read.
//
// No framework-free half to extract here (unlike useMounted/useTimedError): the
// body is a single `Array.prototype.find`, no branching or async worth pulling
// out on its own, so — like useAppVersion — this file has no test of its own;
// there is no DOM renderer wired in this project's vitest setup to exercise the
// `useStore` selector itself.

import type { SessionId, SessionMeta } from '../../../contract/common';
import { useStore } from '../store';

export function useSessionMeta(sessionId: SessionId | null): SessionMeta | null {
  return useStore((s) => s.sessions.find((session) => session.id === sessionId) ?? null);
}

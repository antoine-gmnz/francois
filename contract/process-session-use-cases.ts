// Native application extraction preserves the existing IPC surface.
export type { AgentRuntime, AppError, Result, SessionMeta } from './common';
export type { AnswerQuestionRequest } from './session-questions';
export type { DecidePermissionRequest, PermissionDecision } from './permission-guardrails';

// contract/workflow-panel.ts — workflow-panel (pane [6]).
// Imports shared vocabulary from common.ts; never redefines it.
//
// Physical Tauri binding: `francois:workflows:list` → command `workflows_list`.
// Consumes the workflow.update member of the francois://session/event stream.
//
// The panel is READ-ONLY: a workflow run is dispatched by the assistant during a
// turn (the `Workflow` tool), never by the user from this panel — so unlike
// agents-panel there is no dispatch and no kill verb. Everything the panel knows
// is derived from the session's own NDJSON stream.

import type { SessionId, WorkflowPhaseInfo, WorkflowRun, WorkflowRunId, WorkflowStatus, Result } from './common';

// francois:workflows:list
export interface WorkflowsListRequest {
  sessionId: SessionId;
}
/** This session's runs, in first-seen order. */
export type WorkflowsListResponse = WorkflowRun[];
// invoke('workflows_list', req: WorkflowsListRequest): Promise<Result<WorkflowsListResponse>>
// Errors: SESSION_NOT_FOUND — sessionId matches no registered session.

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts only to
// { type: 'workflow.update'; run: WorkflowRun } filtered to the active session.

export type { SessionId, WorkflowPhaseInfo, WorkflowRun, WorkflowRunId, WorkflowStatus, Result };

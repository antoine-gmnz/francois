// Active Pi IPC is retired by specs/pi-selective-rollback.md.
// Removed: runtime_installation, runtime_models, session_metrics, session_acknowledge_policy,
// session_submit, session_clear_queue, session_reconnect, session_new_from, account_add_pi,
// account_trust_pi, account_pi_setup, account_pi_refresh and profiles_copy_to_pi.
// Tauri registrations, frontend wrappers and request/response exports are removed together.
// Historical read DTOs remain in their existing canonical domains.
// Shared session/account/profile commands retain the RUNTIME_UNSUPPORTED retirement guard.
export type { AgentRuntime, AppError, Result, SessionMeta } from './common';

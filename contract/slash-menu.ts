// contract/slash-menu.ts — slash menu ("/" command autocomplete in the SESSION
// composer + per-session command registry). Authored from specs/slash-menu.md §5.
//
// Physical Tauri binding: `francois:session:listCommands` → command
// `session_list_commands`. The `session.commands` event rides
// francois://session/event (common.ts).
//
// SlashCommandInfo/SlashCommandSource are shared vocabulary (the SessionEvent
// union in common.ts needs them, and common.ts never imports from feature
// files), so they are DECLARED in common.ts and re-exported here (spec §5
// placement rule).

import type { SessionId } from './common';

export type { SlashCommandInfo, SlashCommandSource } from './common';

export interface ListCommandsRequest {
  sessionId: SessionId;
}
// resolves Result<SlashCommandInfo[]>; error: SESSION_NOT_FOUND

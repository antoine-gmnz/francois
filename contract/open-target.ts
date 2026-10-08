import type { Result, SessionId } from './common';

/** HTTP(S) opens in the system browser; files require a session for cwd resolution.
 * Files use the first detected editor in EDITOR_ORDER and may end in :line[:column] or #Lline.
 * No webview navigation, session mutation or shell interpolation. */
export interface OpenTargetRequest {
  sessionId?: SessionId;
  target: string;
}
export type OpenTargetResponse = Result<null>;
// invoke('editor_open_target', { req }): Promise<OpenTargetResponse>

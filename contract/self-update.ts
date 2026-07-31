// contract/self-update.ts — self-update (notice a newer release, install it in place).
// Authored from specs/self-update.md §5. Imports shared vocabulary from common.ts;
// never redefines it.
//
// Physical Tauri binding: `francois:app:<verb>` → `invoke('app_<verb>')`.
// No events: the frontend drives both calls (FR-7, FR-9), so `francois://app/event`
// is untouched by this feature.
//
// | channel                    | command            | payload | resolves                 |
// |----------------------------|--------------------|---------|--------------------------|
// | `francois:app:checkUpdate` | `app_check_update` | —       | `Result<UpdateCheck>`    |
// | `francois:app:applyUpdate` | `app_apply_update` | —       | `Result<UpdateApplyAck>` |

import type { Result } from './common';

/**
 * How this copy of Francois can be updated.
 * 'npm'    — installed by `npm i -g francois`; the core can update in place (FR-5).
 * 'manual' — installed from a .msi/.dmg/.AppImage or built from source; report only.
 */
export type UpdateMethod = 'npm' | 'manual';

export interface UpdateCheck {
  /** The running build, from CARGO_PKG_VERSION (FR-1). */
  current: string;
  /** Newest version on the npm registry — what `@latest` resolves to (FR-2). */
  latest: string;
  /** latest > current as a numeric triple (FR-4). */
  updateAvailable: boolean;
  method: UpdateMethod;
  /** GitHub release body for v<latest>; absent when that fetch failed (FR-3). */
  notes?: string;
  /** Release page for v<latest>. Always present, even when `notes` is not. */
  notesUrl: string;
  /** Verbatim command a manual install should run: 'npm i -g francois@latest'. */
  command: string;
  /** epoch ms this check completed. */
  checkedAt: number;
}

export interface UpdateApplyAck {
  /** The detached relauncher (FR-15). */
  helperPid: number;
  /** The version being installed — echoed so the UI can name it after the check is gone. */
  latest: string;
  /** Absolute path to the helper's update.log (FR-15). */
  logPath: string;
}

// francois:app:checkUpdate — no payload
// errors: 'UPDATE_CHECK_FAILED' (FR-6), 'INTERNAL'
export type CheckUpdateResult = Result<UpdateCheck>;

// francois:app:applyUpdate — no payload
// errors: 'UPDATE_BLOCKED' (FR-12, detail: UpdateBlockedDetail),
//         'UPDATE_APPLY_FAILED' (FR-18), 'INTERNAL'
export type ApplyUpdateResult = Result<UpdateApplyAck>;

/** Shape of `AppError.detail` when the code is 'UPDATE_BLOCKED' (FR-12). */
export interface UpdateBlockedDetail {
  running: number;
}

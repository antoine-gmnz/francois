// contract/pi-migration-rollout.ts — canonical imports for Pi profiles, migration and
// release acceptance. Authored from specs/pi-migration-rollout.md §5.
//
// The spec amends `contract/session-profiles.ts` IN PLACE (no duplicate registry API), so
// this file defines no duplicate shapes:
//   - session-profiles.ts: SessionProfile becomes LegacySessionProfile | PiSessionProfile,
//     ProfileCreateInput / ProfileUpdateInput become unions, PiProfileSettings and its
//     bounds, and the new `profiles_copy_to_pi` command.
//   - session-engine.ts: SessionCreateInput.piProfile.
//   - common.ts: the PROFILE_RUNTIME_MISMATCH error code. ProfileId / SessionProfileRef are
//     unchanged — the ref keeps id/name identity; the settings snapshot is core-private.
//
// Core-private, deliberately NOT defined here: the versioned registry file format, the
// backup/migration journal, and the per-session resolved creation snapshot (FR-3/FR-6).
// No events, matching the existing registry convention.

export type {
  LegacySessionProfile,
  PiBuiltinTool,
  PiProfileSettings,
  PiSessionProfile,
  ProfileCopyToPiInput,
  ProfileCreateInput,
  ProfileUpdateInput,
  SessionProfile,
} from './session-profiles';
export { MAX_PI_INSTRUCTION_PATHS, MAX_PI_SKILL_PATHS, PI_BUILTIN_TOOLS } from './session-profiles';

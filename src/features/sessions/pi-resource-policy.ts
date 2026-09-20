// pi-skills-capabilities FR-5/FR-7 — the New Session form's Pi policy field:
// pure defaults, profile seeding and the RuntimeResourcePolicy the create call
// sends. Kept out of SessionSettingsSheet.tsx (a file shared with the rest of
// the New Session form) per the shared-file minimality rule.

import type { RuntimeResourcePolicy } from '../../../contract/common';
import { PI_UNRESTRICTED_TOOLS_NOTICE } from '../../../contract/pi-skills-capabilities';
import type { SessionProfile } from '../../../contract/session-profiles';

export { PI_UNRESTRICTED_TOOLS_NOTICE };

/** FR-7: unacknowledged, project resources ignored — the safe default every new Pi session starts from. */
export const DEFAULT_PI_RESOURCE_POLICY: RuntimeResourcePolicy = {
  projectResources: 'ignore',
  extensions: 'disabled',
  acknowledgedUnrestrictedTools: false,
};

/**
 * session-profiles FR-16 / pi-skills-capabilities §5: a selected Pi profile's
 * `projectResources` SEEDS the field's initial choice; it never fabricates the
 * per-session acknowledgment (`session-profiles.md §5` is explicit that a
 * profile can only seed the choice, not the ack). A non-Pi profile (or none)
 * carries no `projectResources` at all, so it falls back to the safe default.
 */
export function seedProjectResources(profile: SessionProfile | null | undefined): 'ignore' | 'allow' {
  return profile && profile.kind === 'pi' ? profile.settings.projectResources : 'ignore';
}

/** FR-5/FR-7: the exact wire shape `session_create`/`session_acknowledge_policy`
 *  expect — `extensions` always 'disabled' (the only value this release allows). */
export function resourcePolicyFor(projectResources: 'ignore' | 'allow', acknowledged: boolean): RuntimeResourcePolicy {
  return { projectResources, extensions: 'disabled', acknowledgedUnrestrictedTools: acknowledged };
}

import type { SessionId, SkillInfo } from '../../../contract/common';
import type { SkillsRunRequest } from '../../../contract/skills-panel';

export function buildSkillsRunRequest(sessionId: SessionId, skill: Pick<SkillInfo, 'name'>, args: string | undefined): SkillsRunRequest {
  return { sessionId, name: skill.name, args };
}

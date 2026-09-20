import { describe, expect, it } from 'vitest';
import type { ProjectMeta } from '../../../contract/projects';
import { projectRuntimeModelDefault } from './useProjectDefaults';

function project(defaults: ProjectMeta['defaults'] = {}): ProjectMeta {
  return { id: 'p1', name: 'p1', root: '/repo', rootExists: true, defaults } as ProjectMeta;
}

describe('projectRuntimeModelDefault (pi-models-metrics FR-4)', () => {
  it('is undefined when the project declares no Pi default, same as every other optional default', () => {
    expect(projectRuntimeModelDefault(project())).toBeUndefined();
    expect(projectRuntimeModelDefault(null)).toBeUndefined();
    expect(projectRuntimeModelDefault(undefined)).toBeUndefined();
  });

  it('reads the exact saved pair', () => {
    const ref = { providerId: 'anthropic', modelId: 'claude-sonnet-5' };
    expect(projectRuntimeModelDefault(project({ runtimeModel: ref }))).toEqual(ref);
  });
});

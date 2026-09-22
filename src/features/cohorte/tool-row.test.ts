import { describe, expect, it } from 'vitest';
import { classifyCohorteTool } from './tool-row';

describe('classifyCohorteTool (FR-66, AC-25)', () => {
  it('cohorte run → Cohorte row with the short id, recorded as launched', () => {
    expect(classifyCohorteTool('Bash', 'cohorte run auth-retry --detach', 'started run_7fa3c1d2e3f4 (detached)')).toEqual({
      target: 'run auth-retry --detach',
      meta: 'run_7fa3c1',
      launchedRef: 'run_7fa3c1d2e3f4',
    });
  });

  it('npx cohorte status → Cohorte, not a launch', () => {
    expect(classifyCohorteTool('Bash', 'npx cohorte status', 'run_7fa3c1d2 BUILD')).toEqual({
      target: 'status',
      meta: 'run_7fa3c1',
      launchedRef: null,
    });
    expect(classifyCohorteTool('Bash', 'npx -y cohorte doctor', '')?.target).toBe('doctor');
  });

  it('keeps the existing meta when the result prints no run id', () => {
    expect(classifyCohorteTool('Bash', 'cohorte review run_7fa3c1', '4 findings · 1 blocking')?.meta).toBeNull();
  });

  it('leaves every other tool row unchanged', () => {
    expect(classifyCohorteTool('Bash', 'git status', 'run_7fa3c1d2')).toBeNull();
    expect(classifyCohorteTool('Bash', 'echo cohorte run', '')).toBeNull();
    expect(classifyCohorteTool('Read', 'cohorte run x', '')).toBeNull();
    expect(classifyCohorteTool('Bash', '   ', '')).toBeNull();
  });

  it('accepts a path to the binary', () => {
    expect(classifyCohorteTool('Bash', '/usr/local/bin/cohorte fix run_abcdef12', 'queued run_abcdef1234')?.launchedRef).toBe('run_abcdef1234');
  });
});

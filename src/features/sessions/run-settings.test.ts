import { describe, expect, it } from 'vitest';
import type { ModelInfo, SessionMeta } from '../../../contract/common';
import {
  bypassSinceLine,
  effortSurvivesSwitch,
  familyNote,
  formatSince,
  groupModelFamilies,
  modelNote,
  permissionRows,
  runSettingsPlacement,
} from './run-settings';

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'opus', label: 'Opus 5', ...over });
const session = (over: Partial<SessionMeta> = {}) =>
  ({ id: 's', cwd: '/home/me/code/orbit', permissionMode: 'bypassPermissions', permissionModeSince: 1_000, ...over }) as SessionMeta;

describe('permissionRows', () => {
  it('lists the four modes with the design copy, bypass as the only danger', () => {
    const rows = permissionRows();
    expect(rows.map((r) => r.label)).toEqual(['Default', 'Plan', 'Accept edits', 'Bypass']);
    expect(rows.map((r) => r.note)).toEqual(['ask for risky tools', 'read-only, proposes a plan', 'edits run, shell asks', 'nothing asks']);
    expect(rows.filter((r) => r.danger).map((r) => r.mode)).toEqual(['bypassPermissions']);
  });
});

describe('modelNote', () => {
  it('names the project default before the brief', () => {
    expect(modelNote(model({ brief: 'big' }), 'opus')).toBe('project default');
    expect(modelNote(model({ brief: 'faster, cheaper' }), 'haiku')).toBe('faster, cheaper');
    expect(modelNote(model(), undefined)).toBe('');
  });
});

describe('formatSince', () => {
  it('reads minutes, hours and days', () => {
    expect(formatSince(30_000)).toBe('under a minute');
    expect(formatSince(14 * 60_000)).toBe('14 min');
    expect(formatSince(125 * 60_000)).toBe('2 h 5 min');
    expect(formatSince(120 * 60_000)).toBe('2 h');
    expect(formatSince(3 * 24 * 60 * 60_000)).toBe('3 d');
    expect(formatSince(-5)).toBe('under a minute');
  });
});

describe('bypassSinceLine', () => {
  it('says how long and in which tree, preferring the worktree branch', () => {
    const now = 1_000 + 14 * 60_000;
    expect(bypassSinceLine(session(), now)).toBe('On for 14 min in orbit · every tool runs without asking');
    const wt = session({ worktree: { branch: 'feat/auth-retry' } as SessionMeta['worktree'] });
    expect(bypassSinceLine(wt, now)).toBe('On for 14 min in feat/auth-retry · every tool runs without asking');
    expect(bypassSinceLine(session({ cwd: 'C:\\code\\orbit\\' }), now)).toContain(' in orbit ·');
  });
  it('is null for any other mode or a missing stamp', () => {
    expect(bypassSinceLine(session({ permissionMode: 'plan' }), 5)).toBeNull();
    expect(bypassSinceLine(session({ permissionModeSince: 0 }), 5)).toBeNull();
  });
});

describe('effortSurvivesSwitch', () => {
  it('keeps a level only the next model advertises', () => {
    expect(effortSurvivesSwitch(undefined, model())).toBe(true);
    expect(effortSurvivesSwitch('low', model({ efforts: ['low', 'high'] }))).toBe(true);
    expect(effortSurvivesSwitch('max', model({ efforts: ['low'] }))).toBe(false);
    expect(effortSurvivesSwitch('low', undefined)).toBe(false);
  });
});

describe('groupModelFamilies', () => {
  it('groups by family, newest version first, preserving first-appearance family order', () => {
    const opus5 = model({ id: 'opus-5', label: 'Opus 5' });
    const opus55 = model({ id: 'opus-5.5', label: 'Opus 5.5' });
    const sonnet45 = model({ id: 'sonnet-4.5', label: 'Sonnet 4.5' });
    const sonnet5 = model({ id: 'sonnet-5', label: 'Sonnet 5' });
    const families = groupModelFamilies([opus5, opus55, sonnet45, sonnet5]);
    expect(families.map((f) => f.family)).toEqual(['Opus', 'Sonnet']);
    expect(families[0]!.versions.map((v) => v.label)).toEqual(['5.5', '5']);
    expect(families[0]!.versions.map((v) => v.model)).toEqual([opus55, opus5]);
    expect(families[1]!.versions.map((v) => v.label)).toEqual(['5', '4.5']);
  });

  it('compares dotted version segments numerically, not lexically', () => {
    const v2 = model({ id: 'a', label: 'Family 5.2' });
    const v10 = model({ id: 'b', label: 'Family 5.10' });
    const families = groupModelFamilies([v2, v10]);
    expect(families[0]!.versions.map((v) => v.label)).toEqual(['5.10', '5.2']);
  });

  it('keeps a suffix like (1M) as part of the version label, family unaffected', () => {
    const families = groupModelFamilies([model({ id: 'a', label: 'Sonnet 4.5 (1M)' }), model({ id: 'b', label: 'Sonnet 5 [1m]' })]);
    expect(families).toHaveLength(1);
    expect(families[0]!.family).toBe('Sonnet');
    expect(families[0]!.versions.map((v) => v.label)).toEqual(['5 [1m]', '4.5 (1M)']);
  });

  it('gives an unparseable label its own single-version family, never dropped', () => {
    const codex = model({ id: 'gpt-5-codex', label: 'gpt-5-codex' });
    const o3 = model({ id: 'o3', label: 'o3' });
    const families = groupModelFamilies([codex, o3]);
    expect(families).toEqual([
      { family: 'gpt-5-codex', versions: [{ label: 'gpt-5-codex', model: codex }] },
      { family: 'o3', versions: [{ label: 'o3', model: o3 }] },
    ]);
  });

  it('preserves every ModelInfo exactly', () => {
    const m = model({ id: 'opus-5', label: 'Opus 5', brief: 'flagship', efforts: ['low', 'high'] });
    const families = groupModelFamilies([m]);
    expect(families[0]!.versions[0]!.model).toBe(m);
  });
});

describe('familyNote', () => {
  it('reads project default across any version in the family', () => {
    const v55 = model({ id: 'opus-5.5', label: 'Opus 5.5' });
    const v5 = model({ id: 'opus-5', label: 'Opus 5', brief: 'flagship' });
    const family = groupModelFamilies([v55, v5])[0]!;
    expect(familyNote(family, 'opus-5', 'opus-5.5')).toBe('project default');
    expect(familyNote(family, undefined, 'opus-5.5')).toBe('');
    expect(familyNote(family, undefined, 'opus-5')).toBe('flagship');
  });
});

describe('runSettingsPlacement', () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 340, height: 422 };
  it('opens above the chip, right-aligned to it', () => {
    expect(runSettingsPlacement({ top: 840, right: 1054, bottom: 868 }, viewport, size)).toEqual({ right: 386, top: 410 });
  });
  it('drops below the chip when there is no room above', () => {
    expect(runSettingsPlacement({ top: 100, right: 1054, bottom: 128 }, viewport, size)).toEqual({ right: 386, top: 136 });
  });
});

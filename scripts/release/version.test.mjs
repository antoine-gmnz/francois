import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  decideBump,
  isBreaking,
  nextVersion,
  parseVersion,
  planRelease,
} from './version.mjs';

describe('isBreaking', () => {
  it('detects the `!` marker on the header', () => {
    expect(isBreaking('feat!: drop the dev channel')).toBe(true);
    expect(isBreaking('refactor(core)!: rename the session command')).toBe(true);
  });

  it('detects a BREAKING CHANGE footer in either spelling', () => {
    expect(isBreaking('feat(core): x\n\nBREAKING CHANGE: the event shape moved')).toBe(true);
    expect(isBreaking('fix: y\n\nBREAKING-CHANGE: nope')).toBe(true);
  });

  it('does not fire on a mere mention in the subject', () => {
    expect(isBreaking('docs: explain BREAKING CHANGE footers')).toBe(false);
    expect(isBreaking('feat(agents): dynamic agent tabs')).toBe(false);
  });
});

describe('decideBump', () => {
  it('defaults to patch for fix/chore/unconventional commits', () => {
    expect(decideBump(['fix: a crash'])).toBe('patch');
    expect(decideBump(['chore: bump deps', 'Merge pull request #19 from x/y'])).toBe('patch');
    expect(decideBump(['wip'])).toBe('patch');
  });

  it('picks minor when any commit is a feat', () => {
    expect(decideBump(['fix: a', 'feat(diff): stage hunks', 'chore: c'])).toBe('minor');
    expect(decideBump(['feat: b'])).toBe('minor');
  });

  it('picks major as soon as one commit is breaking, wherever it sits', () => {
    expect(decideBump(['fix: a', 'feat!: b', 'feat: c'])).toBe('major');
  });

  it('ignores empty entries from splitting the log', () => {
    expect(decideBump(['', '  ', 'feat: real'])).toBe('minor');
  });

  // Regression: `git log --format=%B%x00` separates RECORDS with a newline, so
  // every entry but the newest arrives with its subject one line down. That
  // shipped 0.18.15 for a branch carrying two `feat:` commits, because only the
  // newest commit's type was ever read.
  it('reads the subject through the leading newline git leaves on every record but the first', () => {
    expect(decideBump(['fix: newest', '\nfeat(extensions): older feature'])).toBe('minor');
    expect(decideBump(['\n\nfeat: padded'])).toBe('minor');
  });

  it('sees a breaking marker on a shifted subject too', () => {
    expect(decideBump(['fix: newest', '\nfeat!: older breaking change'])).toBe('major');
    expect(isBreaking('\nrefactor!: moved everything')).toBe(true);
  });

  it('treats an empty history as a patch', () => {
    expect(decideBump([])).toBe('patch');
  });

  it('is case-insensitive on the type', () => {
    expect(decideBump(['Feat: shout'])).toBe('minor');
  });
});

describe('parseVersion / compareVersions', () => {
  it('parses a bare and a v-prefixed version, ignoring any suffix', () => {
    expect(parseVersion('0.14.0')).toEqual({ major: 0, minor: 14, patch: 0 });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('0.14.0-dev.7')).toEqual({ major: 0, minor: 14, patch: 0 });
  });

  it('rejects junk', () => {
    expect(() => parseVersion('dev')).toThrow(/not a semver/);
    expect(() => parseVersion('')).toThrow(/not a semver/);
  });

  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.9.0', '0.14.0')).toBeLessThan(0);
    expect(compareVersions('v0.14.1', '0.14.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
  });
});

describe('nextVersion', () => {
  it('bumps patch and minor', () => {
    expect(nextVersion('0.14.0', 'patch')).toEqual({ version: '0.14.1', bump: 'patch' });
    expect(nextVersion('0.14.3', 'minor')).toEqual({ version: '0.15.0', bump: 'minor' });
  });

  it('keeps a breaking change inside 0.x rather than declaring 1.0', () => {
    expect(nextVersion('0.14.0', 'major')).toEqual({ version: '0.15.0', bump: 'minor' });
  });

  it('bumps major once the project is past 1.0', () => {
    expect(nextVersion('1.4.2', 'major')).toEqual({ version: '2.0.0', bump: 'major' });
  });
});

describe('planRelease', () => {
  it('releases from the highest baseline it is given', () => {
    expect(planRelease({ baselines: ['v0.14.0', '0.13.0'], messages: ['fix: a'] })).toEqual({
      current: '0.14.0',
      version: '0.14.1',
      bump: 'patch',
      tag: 'v0.14.1',
    });
  });

  it('respects a manifest hand-bumped ahead of the last tag', () => {
    expect(planRelease({ baselines: ['v0.14.0', '0.20.0'], messages: ['fix: a'] })).toMatchObject({
      current: '0.20.0',
      version: '0.20.1',
    });
  });

  it('tolerates a missing tag (first ever release)', () => {
    expect(planRelease({ baselines: ['', '0.14.0'], messages: ['feat: a'] })).toMatchObject({
      version: '0.15.0',
      tag: 'v0.15.0',
    });
  });

  it('refuses to guess with no baseline at all', () => {
    expect(() => planRelease({ baselines: [], messages: [] })).toThrow(/no baseline/);
  });
});

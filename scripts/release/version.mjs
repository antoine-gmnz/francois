// Pure semver decisions for the automatic release cut on every push to main.
//
// No I/O lives here so it can be unit-tested (`npm test`); bump.mjs is the side of
// the pair that talks to git and rewrites the manifests.

/** Conventional-commit header: `type(scope)!: subject`. */
const HEADER = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:/;

/** A footer marking an incompatible change, either spelling the spec allows. */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE\s*:/m;

/**
 * Split a commit message into its subject and body, ignoring any leading blank
 * lines. Callers read messages out of `git log` with a record delimiter, which
 * leaves a newline in front of every entry but the first — without this, those
 * subjects read as empty and every conventional-commit type behind them is
 * invisible. Defended here rather than only at the caller: this is the half
 * under test.
 * @param {string} message
 */
function subjectAndBody(message) {
  const lines = message.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  return { subject: lines[start] ?? '', body: lines.slice(start + 1).join('\n') };
}

/**
 * Does this commit message declare a breaking change?
 * @param {string} message full commit message (subject + body)
 */
export function isBreaking(message) {
  const { subject, body } = subjectAndBody(message);
  return Boolean(HEADER.exec(subject)?.groups.bang) || BREAKING_FOOTER.test(body);
}

/**
 * The strongest bump any of these commits asks for. Commits that are not
 * conventional at all (merge commits, "wip") only ever earn a patch: pushing to
 * main always releases, so there is no "no bump" outcome.
 *
 * @param {string[]} messages full commit messages
 * @returns {'major' | 'minor' | 'patch'}
 */
export function decideBump(messages) {
  let bump = 'patch';
  for (const message of messages) {
    if (!message.trim()) continue;
    if (isBreaking(message)) return 'major';
    const type = HEADER.exec(subjectAndBody(message).subject)?.groups.type?.toLowerCase();
    if (type === 'feat') bump = 'minor';
  }
  return bump;
}

/**
 * Parse a plain `major.minor.patch`, ignoring any prerelease/build suffix.
 * @param {string} version
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) throw new Error(`not a semver version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Ordering comparator: negative when `a` is older than `b`. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Apply `bump` to `current`.
 *
 * Pre-1.0 guard: while major is 0 a breaking change bumps the MINOR, so an
 * accidental `feat!:` cannot declare 1.0 on the project's behalf. Delete the
 * guard once the app ships 1.0.0.
 *
 * @param {string} current e.g. "0.14.0"
 * @param {'major' | 'minor' | 'patch'} bump
 * @returns {{ version: string, bump: 'major' | 'minor' | 'patch' }}
 */
export function nextVersion(current, bump) {
  const { major, minor, patch } = parseVersion(current);
  const effective = major === 0 && bump === 'major' ? 'minor' : bump;
  if (effective === 'major') return { version: `${major + 1}.0.0`, bump: effective };
  if (effective === 'minor') return { version: `${major}.${minor + 1}.0`, bump: effective };
  return { version: `${major}.${minor}.${patch + 1}`, bump: effective };
}

/**
 * The whole decision: where the version line stands today, and what the commits
 * since it earn. `baseline` candidates are the last released tag and whatever the
 * manifests currently claim — the highest wins, so a hand-bumped manifest is
 * respected and tags stay monotonic.
 *
 * @param {{ baselines: string[], messages: string[] }} input
 */
export function planRelease({ baselines, messages }) {
  const usable = baselines.filter(Boolean);
  if (usable.length === 0) throw new Error('no baseline version to release from');
  const current = usable.reduce((highest, candidate) =>
    compareVersions(candidate, highest) > 0 ? candidate : highest,
  );
  const { version, bump } = nextVersion(current, decideBump(messages));
  return { current: parseVersionString(current), version, bump, tag: `v${version}` };
}

/** Normalise a baseline to a bare `x.y.z` (drops a leading `v`). */
function parseVersionString(version) {
  const { major, minor, patch } = parseVersion(version);
  return `${major}.${minor}.${patch}`;
}

// scripts/quality/sarif.mjs — findings → SARIF 2.1.0.
//
// SARIF is what GitHub code scanning ingests, and ingesting it is what puts a
// finding INLINE on the PR's Files Changed tab instead of in a log nobody
// opens. Hand-rolled rather than pulling a formatter package per tool
// (@microsoft/eslint-formatter-sarif, clippy-sarif): scripts/ is dependency-free
// by convention, and the subset of SARIF that code scanning actually reads is
// this small.
//
// A `finding` is: { rule, severity: 'error'|'warn', path, line?, message }
// where `path` is repo-relative with forward slashes — code scanning silently
// drops results whose URI does not match a file in the checkout, and a Windows
// backslash path is the usual way that happens.

/** SARIF has three levels; our two map onto the first two. */
function level(severity) {
  return severity === 'error' ? 'error' : 'warning';
}

export function buildSarif({ toolName, informationUri, findings }) {
  const ruleIds = [...new Set(findings.map((f) => f.rule))].sort();
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: id },
    // A rule's default is only a fallback; each result carries its own level.
    defaultConfiguration: { level: 'warning' },
  }));
  const ruleIndex = new Map(ruleIds.map((id, i) => [id, i]));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: toolName, informationUri, rules } },
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIndex.get(f.rule),
          level: level(f.severity),
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: normalizeUri(f.path) },
                region: { startLine: Math.max(1, f.line ?? 1) },
              },
            },
          ],
        })),
      },
    ],
  };
}

/** Repo-relative, forward slashes, no leading `./` — see the note above. */
export function normalizeUri(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function serializeSarif(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// cohorte — /review as a deterministic workflow (opt-in; the conversational
// /review command remains the default path and the fallback).
//
// Invoke with args = {feature: "<feature_id>"} (or the bare feature id string).
// Requires Claude Code >= 2.1.154 with workflows enabled — /doctor reports this.
//
// Shape (SCHEMA.md §Workflows): phase 0 reads the profile through the
// profile-reader agent (scripts have no filesystem or shell), the deterministic
// preflight aborts while red (zero reviewers spawned), the diff is staged ONCE
// per touched surface, one reviewer runs per surface in parallel, an adversarial
// cross-check tries to refute every CRITICAL/security finding, and only the
// merged verdict comes back — the full report is staged to specs/reports/.
// Mechanical phases run on haiku; reviewers run the pinned `review` agent (sonnet).

export const meta = {
  name: 'cohorte-review',
  description: 'Review a cohorte feature: preflight gate, one reviewer per touched surface, adversarial cross-check, merged verdict only',
  whenToUse: 'Only when the human explicitly asks for the review workflow of a cohorte feature. args = {feature: "<feature_id>"}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Preflight', detail: 'typecheck + lint + tests — abort while red', model: 'haiku' },
    { title: 'Stage', detail: 'git diff --stat once, per-surface hunks to disk', model: 'haiku' },
    { title: 'Review', detail: 'one review agent per touched surface' },
    { title: 'Cross-check', detail: 'adversarial refutation of CRITICAL/security findings' },
    { title: 'Merge', detail: 'stage merged report + metrics; return the verdict', model: 'haiku' },
  ],
}

const feature = typeof args === 'string' ? args.trim() : args && args.feature
if (!feature) throw new Error('cohorte-review needs args = {feature: "<feature_id>"}')

const PROFILE = { type: 'object', additionalProperties: true }

const PREFLIGHT = {
  type: 'object', required: ['pass'], additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    tail: { type: 'string', description: 'on failure: the raw last lines the script printed' },
  },
}

const STAGE = {
  type: 'object', required: ['surfaces'], additionalProperties: false,
  properties: {
    surfaces: {
      type: 'array',
      items: {
        type: 'object', required: ['key', 'diff', 'files'], additionalProperties: false,
        properties: {
          key: { type: 'string' },
          diff: { type: 'string', description: 'path of the staged .diff file' },
          files: { type: 'array', items: { type: 'string' }, description: 'changed files (from --stat)' },
        },
      },
    },
  },
}

const FINDING = {
  type: 'object', required: ['severity', 'file', 'line', 'kind', 'problem', 'fix'],
  additionalProperties: false,
  properties: {
    severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    file: { type: 'string' }, line: { type: 'integer' },
    kind: { enum: ['spec-violation', 'quality', 'security'] },
    problem: { type: 'string', description: 'one line, no code excerpts' },
    fix: { type: 'string', description: 'one concrete change, one line' },
  },
}

const REPORT = {
  type: 'object', required: ['verdict', 'findings'], additionalProperties: false,
  properties: {
    verdict: { enum: ['SHIP', 'REVISE', 'BLOCK'] },
    findings: { type: 'array', maxItems: 20, items: FINDING },
    overflow: { type: 'integer', description: 'findings beyond the 20-item cap, if any' },
    notes: { type: 'string', description: 'RBAC / mobile-first assessment only, when the profile enables them' },
  },
}

const VERDICT = {
  type: 'object', required: ['refuted', 'reason'], additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string', description: 'one line: why the finding does or does not hold' },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = await agent(
  'Return this project\'s PIPELINE.md `yaml pipeline-profile` block as JSON, per your instructions.',
  { agentType: 'profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
)
if (!profile || profile.error) {
  return { verdict: 'ABORTED', reason: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const cmds = profile.commands || {}
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
const quiet = (q, full) => (q && !String(q).startsWith('<') ? q : full ? `${full} 2>&1 | tail -40` : '')
const checks = [cmds.typecheck, quiet(cmds.lint_quiet, cmds.lint), quiet(cmds.test_quiet, cmds.test)]
  .filter(c => c && !String(c).startsWith('<'))

// ── Phase 1 — deterministic preflight (abort while red, zero reviewers) ─────
phase('Preflight')
const pre = await agent(
  `Run the cohorte deterministic pre-flight for feature ${feature} in ONE Bash call:\n` +
  `<core>/pipeline/scripts/preflight.sh specs/reports/${feature}.preflight.txt ` +
  checks.map(c => JSON.stringify(c)).join(' ') + '\n' +
  '(<core> = .claude if .claude/pipeline/scripts/preflight.sh exists, else ~/.claude — probe with test -x. ' +
  'Script absent on both: run the quoted commands yourself, each appended to the same report file, stopping at the first failure.) ' +
  'Return pass=true only on a fully green run. On failure set pass=false and put the raw last 40 lines of the report in `tail` — verbatim, no summarizing.',
  { model: 'haiku', label: 'preflight', schema: PREFLIGHT, effort: 'low' },
)
if (!pre || !pre.pass) {
  return {
    verdict: 'ABORTED',
    reason: 'preflight red — fix the mechanical failures (or run /fix) before any review; no reviewer was spawned',
    failures: (pre && pre.tail) || 'preflight agent returned nothing',
  }
}

// ── Phase 2 — stage the diff once ────────────────────────────────────────────
phase('Stage')
const surfaceList = surfaces.map(s => `${s.key} → ${s.path}`).join(' · ') || '(none declared)'
const staged = await agent(
  `Stage the review inputs for cohorte feature ${feature}. Diff base: ${base}. Surfaces: ${surfaceList}.\n` +
  `1. ONE call: git diff ${base} --stat > specs/reports/${feature}.stat.txt — never print the diff.\n` +
  '2. Group the changed paths by surface path prefix; paths under no surface are the `shared` remainder — attach them to the most relevant surface.\n' +
  `3. Per surface that has changed paths (ONLY those): git diff ${base} -- <surface.path> [<remainder pathspecs>] > specs/reports/${feature}.<key>.diff\n` +
  '4. Return the touched surfaces with their staged diff path and changed-file list. No changed paths at all ⇒ return an empty surfaces array.',
  { model: 'haiku', label: 'stage-diff', schema: STAGE, effort: 'low' },
)
const touched = (staged && staged.surfaces) || []
if (!touched.length) return { verdict: 'SHIP', reason: `no diff against ${base} — nothing to review`, findings: 0 }
log(`Touched surfaces: ${touched.map(s => s.key).join(', ')}`)

// ── Phases 3+4 — review each surface, cross-check its hard findings ─────────
// pipeline(): a fast surface's cross-check starts while a slow one still reviews.
const reviewed = await pipeline(
  touched,
  s => agent(
    'Review one feature surface against its frozen spec, per your agent instructions (read the staged ' +
    'diff FIRST; open a full source file only when a finding demands it; capped shape — max 20 findings, ' +
    'one line each, no code excerpts). — Variable slots: ' +
    `feature ${feature} · scope: the ${s.key} surface only · spec: specs/${feature}.md · ` +
    `staged diff: ${s.diff} · changed files: ${s.files.join(', ')}`,
    { agentType: 'review', label: `review:${s.key}`, phase: 'Review', schema: REPORT },
  ),
  async (report, s) => {
    if (!report) return null
    const hard = report.findings.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
    const rest = report.findings.filter(f => !hard.includes(f))
    if (!hard.length) return { key: s.key, report, kept: rest, refuted: [] }
    const votes = await parallel(hard.map(f => () => agent(
      'Adversarially verify ONE review finding — your job is to REFUTE it if you can. Read the staged ' +
      'diff and the exact file:line; refuted=true when the code, a guard, a test, or the spec shows the ' +
      'finding does not hold. Uncertain ⇒ refuted=false (a real CRITICAL must not die on doubt). — ' +
      `Finding: [${f.severity}/${f.kind}] ${f.file}:${f.line} — ${f.problem} (proposed fix: ${f.fix}). ` +
      `Feature ${feature} · spec: specs/${feature}.md · staged diff: ${s.diff}`,
      { agentType: 'review', label: `verify:${s.key}`, phase: 'Cross-check', schema: VERDICT },
    ).then(v => ({ f, refuted: !!(v && v.refuted), reason: v ? v.reason : 'verifier died — kept' }))))
    const checkedVotes = votes.filter(Boolean)
    return {
      key: s.key,
      report,
      kept: rest.concat(checkedVotes.filter(v => !v.refuted).map(v => v.f)),
      refuted: checkedVotes.filter(v => v.refuted).map(v => ({ ...v.f, reason: v.reason })),
    }
  },
)

const results = reviewed.filter(Boolean)
const kept = results.flatMap(r => r.kept.map(f => ({ ...f, surface: r.key })))
const refuted = results.flatMap(r => r.refuted.map(f => ({ ...f, surface: r.key })))
const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
for (const f of kept) counts[f.severity] = (counts[f.severity] || 0) + 1
// Verdict from the findings that SURVIVED the cross-check (a refuted CRITICAL
// must not force a fix loop): security ⇒ BLOCK, CRITICAL ⇒ REVISE, else SHIP.
const verdict = kept.some(f => f.kind === 'security') ? 'BLOCK'
  : kept.some(f => f.severity === 'CRITICAL') ? 'REVISE' : 'SHIP'

// ── Phase 5 — stage the merged report; only the verdict leaves the workflow ──
phase('Merge')
const findingLine = f =>
  `- [${f.severity}] \`${f.file}:${f.line}\` · ${f.kind} · ${f.problem} → **Fix:** ${f.fix}`
const reportBody = [
  '# REVIEW REPORT', `feature_id: ${feature} · merged by cohorte-review workflow`, '',
  '| Severity | Count |', '| -------- | ----- |',
  ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => `| ${s} | ${counts[s] || 0} |`), '',
  `Verdict: ${verdict}`, '', '## Findings', '',
  kept.length ? kept.map(findingLine).join('\n') : 'None.',
  ...(refuted.length ? ['', '## Refuted by cross-check (no action needed)', '',
    refuted.map(f => `- ${f.file}:${f.line} · ${f.problem} — refuted: ${f.reason}`).join('\n')] : []),
].join('\n')
await agent(
  `Stage a cohorte review report and its metrics, mechanically:\n` +
  `1. Write EXACTLY this content to specs/reports/${feature}.md (overwrite):\n<<<REPORT\n${reportBody}\nREPORT\n` +
  `2. Append one line to $(dirname "$(git rev-parse --git-common-dir)")/.claude/pipeline-metrics.jsonl: ` +
  `{"ts":"<ISO now>","feature":"${feature}","phase":"review","seconds":0,"surfaces":{${results.map(r => `"${r.key}":"${verdict}:${r.kept.length}"`).join(',')}}}\n` +
  `3. Chain the opt-in usage ping: <core>/pipeline/scripts/telemetry-send.sh review "${feature}" 0 "${verdict}:${kept.length}" || true\n` +
  'Return the single word: done.',
  { model: 'haiku', label: 'stage-report', effort: 'low' },
)

return {
  verdict,
  counts,
  refutedByCrossCheck: refuted.length,
  criticals: kept.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
    .map(f => `[${f.surface}] ${f.file}:${f.line} — ${f.problem}`),
  report: `specs/reports/${feature}.md`,
  next: verdict === 'SHIP' ? `/ship ${feature} (after DoD ticks)` : `/fix ${feature}`,
}

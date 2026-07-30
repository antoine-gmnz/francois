// cohorte — the FULL dev cycle as one deterministic workflow (opt-in):
// contract → build → [preflight → smoke ∥ review(+cross-check) → fix]* → done.
//
// Invoke with args = {feature: "<feature_id>", maxRounds?: 3} in the feature's
// checkout (main checkout on the feature branch, or its worktree).
//
// The contract with the human: a workflow can NEVER ask a question mid-run, so
// everything decisional is moved to the edges —
//   · UPSTREAM: the spec must be frozen and self-sufficient (design links in the
//     front-matter, complete §5 contract). A readiness gate checks this FIRST
//     and aborts with the list of gaps as `questions` before spending anything.
//     A well-run /brainstorm + /spec IS the answer sheet — the sharper it is,
//     the further the cycle runs with an empty questions array.
//   · DOWNSTREAM: the loop runs review→fix→review until ZERO open findings and
//     a PASS smoke (bounded by maxRounds + the token budget). Even a finding
//     that implies a CONTRACT change stays inside the loop: a lead-equivalent
//     agent re-authors spec §5 + the contract file (exactly what /fix does
//     conversationally — implementers still never touch it), the affected
//     surfaces re-dispatch, and the loop continues. Only what is genuinely
//     human comes back at the END, in the result's `questions` array (spec
//     ambiguities the readiness gate flagged, a hit round-cap/budget) — ready
//     to feed a follow-up fix/review loop if you decide to keep going.
// /ship stays out on purpose: it is the outward-facing, irreversible gate and
// keeps its human confirmation. A SHIP exit ticks the DoD + stamps the
// freshness gate, so `/ship <id>` right after is a straight shot.
//
// Loop economics: smoke and review run CONCURRENTLY each round (both observe,
// neither edits); fix rounds re-dispatch only the surfaces owning findings;
// the loop is bounded by maxRounds AND by the session token budget if one is
// set. Disk state stays pipeline-coherent: reports staged to specs/reports/,
// unresolved findings appended to the spec's ## Remediation — a conversational
// /fix can always pick up where the workflow stopped.

export const meta = {
  name: 'cohorte-cycle',
  description: 'Full cohorte dev cycle: contract, parallel build, then bounded smoke∥review→fix rounds; deferred questions in the output, never mid-run',
  whenToUse: 'Only when the human explicitly asks to run the full dev-cycle workflow on a FROZEN spec. args = {feature: "<feature_id>", maxRounds?: 3}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Ready', detail: 'spec frozen + self-sufficient, or abort with the gaps', model: 'haiku' },
    { title: 'Contract', detail: 'author the frozen contract from spec §5' },
    { title: 'Build', detail: 'one implementer per surface, parallel' },
    { title: 'Verify', detail: 'per round: preflight → smoke ∥ review + cross-check' },
    { title: 'Fix', detail: 'per round: re-dispatch only the surfaces with findings' },
    { title: 'Close', detail: 'reports, Remediation/DoD, freshness stamp, metrics', model: 'haiku' },
  ],
}

const feature = typeof args === 'string' ? args.trim() : args && args.feature
if (!feature) throw new Error('cohorte-cycle needs args = {feature: "<feature_id>"}')
// Runaway protection, not a target — the loop's real exit is 0 findings + PASS.
const MAX_ROUNDS = Math.max(1, (args && args.maxRounds) || 5)

const questions = []        // every deferred human decision ends up here — emitted at the END
const contractChanges = []  // contract re-authorings the loop performed (info, not questions)

const PROFILE = { type: 'object', additionalProperties: true }
const READY = {
  type: 'object', required: ['frozen', 'gaps', 'designLinks'], additionalProperties: false,
  properties: {
    frozen: { type: 'boolean', description: 'front-matter status is frozen or in-review' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'anything the cycle would have had to ask about' },
    designLinks: { type: 'string', description: 'the design_files links, comma-joined, or "none"' },
  },
}
const PREFLIGHT = {
  type: 'object', required: ['pass'], additionalProperties: false,
  properties: { pass: { type: 'boolean' }, tail: { type: 'string' } },
}
const STAGE = {
  type: 'object', required: ['surfaces'], additionalProperties: false,
  properties: {
    surfaces: {
      type: 'array',
      items: {
        type: 'object', required: ['key', 'diff', 'files'], additionalProperties: false,
        properties: {
          key: { type: 'string' }, diff: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
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
    problem: { type: 'string' }, fix: { type: 'string' },
  },
}
const REPORT = {
  type: 'object', required: ['verdict', 'findings'], additionalProperties: false,
  properties: {
    verdict: { enum: ['SHIP', 'REVISE', 'BLOCK'] },
    findings: { type: 'array', maxItems: 20, items: FINDING },
    overflow: { type: 'integer' },
  },
}
const VERDICT = {
  type: 'object', required: ['refuted', 'reason'], additionalProperties: false,
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}
const SMOKE = {
  type: 'object', required: ['pass', 'failures'], additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    failures: {
      type: 'array', maxItems: 10,
      items: { type: 'string', description: '❌ <flow/endpoint> · expected <x> got <y> · file hint if known' },
    },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = await agent(
  'Return this project\'s PIPELINE.md `yaml pipeline-profile` block as JSON, per your instructions.',
  { agentType: 'profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
)
if (!profile || profile.error) {
  return { outcome: 'ABORTED', questions: [`profile unreadable: ${(profile && profile.error) || 'no return'} — run /init-pipeline or /doctor`] }
}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
const byKey = Object.fromEntries(surfaces.map(s => [s.key, s]))
const cmds = profile.commands || {}
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const contract = profile.contract || {}
const contractFile = contract.enabled ? `${contract.path}/${feature}.${contract.ext || 'ts'}` : ''
const quiet = (q, full) => (q && !String(q).startsWith('<') ? q : full ? `${full} 2>&1 | tail -40` : '')
const checks = [cmds.typecheck, quiet(cmds.lint_quiet, cmds.lint), quiet(cmds.test_quiet, cmds.test)]
  .filter(c => c && !String(c).startsWith('<'))

// ── Phase 1 — readiness gate: the spec must pre-answer everything ───────────
phase('Ready')
const ready = await agent(
  `Readiness check for the cohorte full-cycle workflow on spec specs/${feature}.md — the run can ask ` +
  'NOTHING mid-flight, so list every gap a lead would normally have to ask about. Read the spec ' +
  '(front-matter + §5 contract + per-surface tasks + §9 acceptance) and report:\n' +
  '- frozen: front-matter status is `frozen` or `in-review`\n' +
  '- gaps: e.g. status draft/missing; §5 contract absent or with open placeholders/TODOs; a surface\'s ' +
  'tasks empty while §5 clearly implies work there; `design_files` empty while a uses_design surface ' +
  `has tasks (uses_design surfaces: ${surfaces.filter(s => s.uses_design).map(s => s.key).join(', ') || 'none'}); ` +
  'open `## Remediation` items that imply a contract change\n' +
  '- designLinks: the design_files links comma-joined, or "none"',
  { model: 'haiku', label: 'ready', schema: READY, effort: 'low' },
)
if (!ready || !ready.frozen) {
  return {
    outcome: 'NOT-READY',
    questions: ((ready && ready.gaps) || ['spec unreadable']).concat(
      ['freeze the spec first: /spec (the cycle only runs on a frozen, self-sufficient spec)']),
  }
}
questions.push(...(ready.gaps || []))   // non-blocking gaps ride along as deferred questions
const designLinks = ready.designLinks || 'none'

// ── Phase 2 — author the contract (lead-equivalent, the single sync channel) ─
if (contract.enabled) {
  phase('Contract')
  const c = await agent(
    `Author the frozen contract for cohorte feature ${feature}, acting as the lead (/build §2): from ` +
    `spec specs/${feature}.md §5, write/update ${contractFile} in the profile's mechanism ` +
    `(${contract.mechanism})${contract.index ? `, exported from ${contract.index}` : ''}. ` +
    'Postcondition: the file exists and typechecks. Implementers import it read-only. ' +
    'Return one line: what you wrote, or what blocked you.',
    { label: 'contract' },
  )
  if (c == null) return { outcome: 'ABORTED', questions: questions.concat(['contract authoring failed — run /build manually']) }
}

// ── Phase 3 — build: one implementer per surface, parallel ───────────────────
phase('Build')
const buildPrompt = s =>
  `Implement the **${s.key}** surface for feature \`${feature}\`. Read \`PIPELINE.md\` first. ` +
  `Spec: \`specs/${feature}.md\`. Contract: \`${contractFile || 'none — spec §5 prose is the contract'}\` ` +
  '(import read-only). Work test-first. Touch only `' + s.path + '`. Need the current state of your ' +
  `tree? Compute it yourself: \`git diff ${base} -- ${s.path}\`. Return the handoff in the format ` +
  `your agent instructions define. Design files: ${s.uses_design ? designLinks : 'none'}. ` +
  'Open Remediation items for YOUR surface (`none` ⇒ first build, implement the spec\'s tasks for ' +
  'your surface): none'
const handoffs = await parallel(surfaces.map(s => () =>
  agent(buildPrompt(s), { agentType: s.agent, label: `build:${s.key}`, phase: 'Build' })
    .then(h => ({ key: s.key, handoff: h }))))
const built = handoffs.filter(Boolean)
const dead = surfaces.filter(s => !built.some(b => b.key === s.key)).map(s => s.key)
if (dead.length) questions.push(`implementer(s) died during build: ${dead.join(', ')} — inspect and re-run /build if their surface matters`)

// ── helpers for the verify/fix rounds ────────────────────────────────────────
const surfaceOf = file => {
  for (const s of surfaces) if (file && String(file).startsWith(String(s.path))) return s.key
  return null
}
const itemLine = f => `- [ ] ${f.severity} · ${f.file}:${f.line} · ${f.kind} · ${f.fix}`
const runPreflight = () => agent(
  `Run the cohorte deterministic pre-flight for feature ${feature} in ONE Bash call:\n` +
  `<core>/pipeline/scripts/preflight.sh specs/reports/${feature}.preflight.txt ` +
  checks.map(c => JSON.stringify(c)).join(' ') + '\n' +
  '(<core> = .claude if .claude/pipeline/scripts/preflight.sh exists, else ~/.claude; script absent ⇒ ' +
  'run the quoted commands yourself into the same file, stopping at the first failure.) ' +
  'pass=true only on fully green; on failure put the raw last 40 lines in tail, verbatim.',
  { model: 'haiku', label: 'preflight', phase: 'Verify', schema: PREFLIGHT, effort: 'low' },
)

let verdict = null
let smokePass = false
let open = []            // findings still open, each {severity,file,line,kind,problem,fix,src}
let rounds = 0

// ── Phases 4/5 — bounded verify → fix rounds ────────────────────────────────
while (rounds < MAX_ROUNDS && (!budget.total || budget.remaining() > 30000)) {
  rounds++
  log(`Round ${rounds}/${MAX_ROUNDS}`)
  phase('Verify')

  // 4a. preflight — mechanical red short-circuits straight to a fix round
  const pre = await runPreflight()
  if (!pre || !pre.pass) {
    const tail = (pre && pre.tail) || ''
    const hit = new Set(surfaces.filter(s => tail.includes(String(s.path))).map(s => s.key))
    const targets = hit.size ? [...hit] : built.map(b => b.key)
    log(`Preflight red — mechanical fix round on: ${targets.join(', ')}`)
    phase('Fix')
    await parallel(targets.filter(k => byKey[k]).map(k => () => agent(
      `Fix loop for feature \`${feature}\` on your surface (**${k}**). Read \`PIPELINE.md\` first. ` +
      `Contract: \`${contractFile || 'spec §5'}\` (read-only). Touch only \`${byKey[k].path}\`. ` +
      'The mechanical gates (typecheck/lint/tests) are RED. Raw failure tail below — fix exactly ' +
      'what concerns your tree, then rerun your quiet commands until green. Failures:\n' + tail,
      { agentType: byKey[k].agent, label: `fix:${k}`, phase: 'Fix' })))
    continue
  }

  // 4b. stage the diff once for the reviewers
  const staged = await agent(
    `Stage review inputs for cohorte feature ${feature}. Diff base: ${base}. Surfaces: ` +
    surfaces.map(s => `${s.key} → ${s.path}`).join(' · ') + '.\n' +
    `1. git diff ${base} --stat > specs/reports/${feature}.stat.txt (never print it). ` +
    '2. Group changed paths by surface prefix (unowned paths = shared remainder → most relevant surface). ' +
    `3. Per touched surface only: git diff ${base} -- <path> [remainder] > specs/reports/${feature}.<key>.diff. ` +
    '4. Return the touched surfaces (empty array if no diff).',
    { model: 'haiku', label: 'stage-diff', phase: 'Verify', schema: STAGE, effort: 'low' },
  )
  const touched = (staged && staged.surfaces) || []
  if (!touched.length) { questions.push(`no diff against ${base} after build — wrong branch/checkout?`); break }

  // 4c. smoke ∥ review(+cross-check) — both observe, neither edits: run together
  const [smoke, reviewed] = await parallel([
    () => agent(
      'Smoke-test one feature, per your agent instructions (bring it up, exercise the contract + §8 UI ' +
      'flows, stage the full SMOKE REPORT, tear down; return the capped shape — pass + max 10 one-line ' +
      `failures with a file hint when you have one). — Variable slots: feature ${feature} · spec: ` +
      `specs/${feature}.md · contract: ${contractFile || 'spec §5'} · report: specs/reports/${feature}.smoke.md · ` +
      'checkout: the current working directory (already the feature checkout) · ports/db: the profile/slot defaults',
      { agentType: 'smoke', label: 'smoke', phase: 'Verify', schema: SMOKE }),
    () => pipeline(
      touched,
      s => agent(
        'Review one feature surface against its frozen spec, per your agent instructions (staged diff ' +
        'FIRST; capped shape — max 20 one-line findings, no code excerpts). — Variable slots: ' +
        `feature ${feature} · scope: the ${s.key} surface only · spec: specs/${feature}.md · ` +
        `staged diff: ${s.diff} · changed files: ${s.files.join(', ')}`,
        { agentType: 'review', label: `review:${s.key}`, phase: 'Verify', schema: REPORT }),
      async (report, s) => {
        if (!report) return null
        const hard = report.findings.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
        const rest = report.findings.filter(f => !hard.includes(f))
        if (!hard.length) return { key: s.key, kept: rest }
        const votes = await parallel(hard.map(f => () => agent(
          'Adversarially verify ONE review finding — REFUTE it if you can (code, guard, test, or spec ' +
          'shows it does not hold); uncertain ⇒ refuted=false. — Finding: ' +
          `[${f.severity}/${f.kind}] ${f.file}:${f.line} — ${f.problem} (fix: ${f.fix}). ` +
          `Feature ${feature} · spec: specs/${feature}.md · staged diff: ${s.diff}`,
          { agentType: 'review', label: `verify:${s.key}`, phase: 'Verify', schema: VERDICT },
        ).then(v => ({ f, refuted: !!(v && v.refuted) }))))
        return { key: s.key, kept: rest.concat(votes.filter(Boolean).filter(v => !v.refuted).map(v => v.f)) }
      },
    ),
  ])

  smokePass = !!(smoke && smoke.pass)
  const smokeFails = (smoke && smoke.failures) || []
  open = (reviewed || []).filter(Boolean).flatMap(r => r.kept.map(f => ({ ...f, src: r.key })))
  verdict = open.some(f => f.kind === 'security') ? 'BLOCK'
    : open.some(f => f.severity === 'CRITICAL') ? 'REVISE' : 'SHIP'
  log(`Round ${rounds}: review ${verdict} (${open.length} finding(s)) · smoke ${smokePass ? 'PASS' : `FAIL:${smokeFails.length}`}`)

  if (verdict === 'SHIP' && smokePass) break
  if (rounds >= MAX_ROUNDS) break

  // 5. fix round. Contract-impacting findings stay INSIDE the loop: a
  //    lead-equivalent agent re-authors spec §5 + the contract file (implementers
  //    still never touch it — same division of labor as conversational /fix §1),
  //    and the surfaces it names re-dispatch against the updated shapes.
  phase('Fix')
  const contractFindings = contractFile
    ? open.filter(f => String(f.file).startsWith(String(contract.path))) : []
  let rippleSurfaces = []
  if (contractFindings.length) {
    const cf = await agent(
      `Act as the cohorte lead on a contract change for feature ${feature} (exactly /fix §1's contract ` +
      `check): the findings below show the frozen contract is wrong. Update spec specs/${feature}.md §5 ` +
      `accordingly, then re-author ${contractFile} (mechanism: ${contract.mechanism}` +
      `${contract.index ? `, exported from ${contract.index}` : ''}) until it typechecks. Findings:\n` +
      contractFindings.map(f => `- ${f.file}:${f.line} — ${f.problem} (fix: ${f.fix})`).join('\n') + '\n' +
      'Return ONE line: `<what changed> || <comma-separated surface keys that consume the changed shapes>` ' +
      `(surfaces: ${surfaces.map(s => s.key).join(', ')}; when in doubt list them all).`,
      { label: 'contract-fix', phase: 'Fix' },
    )
    const [what, keys] = String(cf || '').split('||').map(x => x && x.trim())
    contractChanges.push(what || 'contract re-authored (agent gave no summary)')
    rippleSurfaces = (keys ? keys.split(',').map(k => k.trim()) : surfaces.map(s => s.key))
      .filter(k => byKey[k])
  }

  //    Group the remaining findings by owning surface; smoke failures ride with
  //    the surface their file hint maps to, else the surface with most findings.
  const perSurface = {}
  for (const k of rippleSurfaces) {
    (perSurface[k] = perSurface[k] || []).push(
      `- [ ] CRITICAL · ${contractFile} · spec-violation · the contract was RE-AUTHORED this round (${contractChanges[contractChanges.length - 1]}) — re-read it and realign your surface's implementation + tests`)
  }
  for (const f of open.filter(f => !contractFindings.includes(f))) {
    const k = surfaceOf(f.file) || f.src
    if (byKey[k]) (perSurface[k] = perSurface[k] || []).push(itemLine(f))
  }
  const fallbackKey = Object.keys(perSurface).sort((a, b) => perSurface[b].length - perSurface[a].length)[0]
    || (built[0] && built[0].key)
  for (const line of smokeFails) {
    const k = surfaceOf((line.match(/[\w./-]+\.\w{1,4}/) || [])[0]) || fallbackKey
    if (byKey[k]) (perSurface[k] = perSurface[k] || []).push(`- [ ] HIGH · runtime · smoke failure · ${line}`)
  }
  if (!Object.keys(perSurface).length) { questions.push('open findings map to no surface — run /fix manually'); break }
  await parallel(Object.entries(perSurface).map(([k, items]) => () => agent(
    `Fix loop for feature \`${feature}\` on your surface (**${k}**). Read \`PIPELINE.md\` first. ` +
    `Contract: \`${contractFile || 'spec §5'}\` (read-only — report mismatches, never edit it). Touch only ` +
    `\`${byKey[k].path}\`. Need your tree's current state? \`git diff ${base} -- ${byKey[k].path}\`. ` +
    'Fix exactly the open items below (self-contained — read only the files they name), then rerun your ' +
    'quiet commands until green. Return the handoff your agent instructions define. Design files: ' +
    `${byKey[k].uses_design ? designLinks : 'none'}. Open items for YOUR surface:\n` + items.join('\n'),
    { agentType: byKey[k].agent, label: `fix:${k}`, phase: 'Fix' })))
}

if (rounds >= MAX_ROUNDS && !(verdict === 'SHIP' && smokePass)) {
  questions.push(`round cap (${MAX_ROUNDS}) reached with ${open.length} finding(s) open — rerun the cycle (maxRounds higher) or continue with /fix ${feature} + /review`)
}
if (budget.total && budget.remaining() <= 30000 && !(verdict === 'SHIP' && smokePass)) {
  questions.push('token budget nearly spent — cycle stopped early; rerun the cycle or continue conversationally')
}

// ── Phase 6 — close: reports, spec bookkeeping, freshness stamp, metrics ────
phase('Close')
const success = verdict === 'SHIP' && smokePass
const findingLine = f => `- **[${f.severity}]** \`${f.file}:${f.line}\` · ${f.kind} · ${f.problem} → **Fix:** ${f.fix}`
const reportBody = [
  '# REVIEW REPORT', `feature_id: ${feature} · merged by cohorte-cycle workflow (round ${rounds})`, '',
  `Verdict: ${verdict || 'NOT-REACHED'} · smoke: ${smokePass ? 'PASS' : 'FAIL'}`, '', '## Findings', '',
  open.length ? open.map(findingLine).join('\n') : 'None.',
].join('\n')
await agent(
  `Close a cohorte cycle run for feature ${feature}, mechanically:\n` +
  `1. Write EXACTLY this to specs/reports/${feature}.md (overwrite):\n<<<REPORT\n${reportBody}\nREPORT\n` +
  (success
    ? `2. In specs/${feature}.md tick the DoD boxes the cycle verified (spec conformance + copy language — ` +
      'review SHIP; tests/lint/typecheck — green preflight; runtime flows — smoke PASS); leave anything ' +
      'unverified unticked. 3. Stamp the freshness gate in the spec front-matter, exactly as /review §3 ' +
      `does: BASE=$(git merge-base ${base} HEAD); reviewed_base: $BASE; reviewed_digest: ` +
      `$(git diff $BASE -- . ':(exclude)specs/' | sha256sum | cut -c1-16).\n` :
    `2. Append the open findings to specs/${feature}.md \`## Remediation\` under a subheading ` +
      `\`### cohorte-cycle round ${rounds}\`, one \`- [ ]\` line each (so a conversational /fix picks them ` +
      'up):\n' + (open.map(itemLine).join('\n') || '(none — see questions in the workflow result)') + '\n' +
      `Set the front-matter status: in-review.\n`) +
  `4. Append ONE metrics line to $(dirname "$(git rev-parse --git-common-dir)")/.claude/pipeline-metrics.jsonl: ` +
  `{"ts":"<ISO now>","feature":"${feature}","phase":"cycle","seconds":0,"surfaces":{"rounds":"${rounds}","verdict":"${verdict || 'none'}:${open.length}","smoke":"${smokePass ? 'PASS' : 'FAIL'}"}}\n` +
  '5. Chain the opt-in usage pings (all funnel phases this run executed, 0 seconds each): ' +
  `<core>/pipeline/scripts/telemetry-send.sh build "${feature}" 0 "${built.map(() => 'ok').join(',') || 'error'}" || true; ` +
  `<core>/pipeline/scripts/telemetry-send.sh smoke "${feature}" 0 "${smokePass ? 'PASS' : 'FAIL:' + open.filter(f => f.kind === 'runtime').length}" || true; ` +
  `<core>/pipeline/scripts/telemetry-send.sh review "${feature}" 0 "${verdict || 'none'}:${open.length}" || true\n` +
  'Return the single word: done.',
  { model: 'haiku', label: 'close', effort: 'low' },
)

return {
  outcome: success ? 'SHIP-READY' : 'STOPPED',
  rounds,
  verdict: verdict || 'not reached',
  smoke: smokePass ? 'PASS' : 'FAIL',
  contractChanges,   // re-authorings the loop performed itself — review them in the diff
  openFindings: open.slice(0, 10).map(f => `[${f.severity}] ${f.file}:${f.line} — ${f.problem}`),
  questions,         // everything deferred to you — empty when /brainstorm + /spec did their job
  report: `specs/reports/${feature}.md`,
  next: success
    ? `/ship ${feature} — DoD ticked + freshness stamped, ship is a straight shot (human confirm stays)`
    : `answer the questions, then rerun the cycle — or continue with /fix ${feature} + /review (Remediation is up to date)`,
}

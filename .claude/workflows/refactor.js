// cohorte — /refactor as a deterministic workflow (opt-in; the conversational
// /refactor command remains the default path and the fallback).
//
// BIG domains only: a domain with just a handful of open backlog items is
// cheaper through the conversational /refactor — this script skips it and says
// so. Invoke with args = {domains: ["backend", …]} or {domains: "all"}.
//
// Shape (SCHEMA.md §Workflows): profile via profile-reader (phase 0), the open
// backlog read once, the `shared` domain (contract package — every slice
// imports it) refactored FIRST and alone, then the other domains' surface
// implementers in parallel (their trees are disjoint by construction), each
// verified per-domain with one bounded retry round, and the backlog ticked.

export const meta = {
  name: 'cohorte-refactor',
  description: 'Apply the /audit refactor backlog for big domains: shared first, then parallel surface implementers, per-domain verify + one retry',
  whenToUse: 'Only when the human explicitly asks for the refactor workflow on big domains. args = {domains: ["<surface key>", …] | "all"}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Backlog', detail: 'read the open items per requested domain', model: 'haiku' },
    { title: 'Shared', detail: 'refactor the contract package first, alone' },
    { title: 'Refactor', detail: 'one surface implementer per domain, parallel' },
    { title: 'Verify', detail: 'per-domain gates + item check, one retry round', model: 'haiku' },
    { title: 'Tick', detail: 'check cleared items off specs/refactor-backlog.md', model: 'haiku' },
  ],
}

// A domain below this many open items is not "big" — the conversational
// /refactor handles it with less overhead than a workflow run.
const MIN_ITEMS = 5

const wanted = (() => {
  const d = args && args.domains
  if (!d || d === 'all') return 'all'
  return Array.isArray(d) ? d : [String(d)]
})()

const PROFILE = { type: 'object', additionalProperties: true }

const OPEN = {
  type: 'object', required: ['domains'], additionalProperties: false,
  properties: {
    domains: {
      type: 'array',
      items: {
        type: 'object', required: ['key', 'items'], additionalProperties: false,
        properties: {
          key: { type: 'string' },
          items: { type: 'array', items: { type: 'string', description: 'the open `- [ ] …` line verbatim' } },
        },
      },
    },
  },
}

const VERIFY = {
  type: 'object', required: ['cleared', 'remaining', 'gatesGreen'], additionalProperties: false,
  properties: {
    cleared: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    gatesGreen: { type: 'boolean' },
    failures: { type: 'string', description: 'one line per gate failure, no output dumps' },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = await agent(
  'Return this project\'s PIPELINE.md `yaml pipeline-profile` block as JSON, per your instructions.',
  { agentType: 'profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
)
if (!profile || profile.error) {
  return { error: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
const byKey = Object.fromEntries(surfaces.map(s => [s.key, s]))
const contractPath = (profile.contract && profile.contract.path) || ''
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const quiet = s => (s.test_quiet_cmd && !String(s.test_quiet_cmd).startsWith('<'))
  ? s.test_quiet_cmd : s.test_cmd ? `${s.test_cmd} 2>&1 | tail -40` : ''

// ── Phase 1 — read the open backlog ──────────────────────────────────────────
phase('Backlog')
const backlog = await agent(
  'Read specs/refactor-backlog.md and return, per `## <domain>` heading, the OPEN `- [ ] …` item lines ' +
  'verbatim (skip checked `- [x]` ones). File missing ⇒ return an empty domains array. ' +
  `Requested domains: ${wanted === 'all' ? 'all' : wanted.join(', ')} — return only those (all ⇒ every domain with open items).`,
  { model: 'haiku', label: 'read-backlog', schema: OPEN, effort: 'low' },
)
const open = ((backlog && backlog.domains) || []).filter(d => d.items.length)
if (!open.length) return { error: 'no open backlog items for the requested domains — run /audit (or the audit workflow) first' }

const big = open.filter(d => d.items.length >= MIN_ITEMS)
const small = open.filter(d => d.items.length < MIN_ITEMS)
for (const d of small) log(`Skipping ${d.key} (${d.items.length} open item(s) < ${MIN_ITEMS}) — use the conversational /refactor ${d.key}, it's cheaper`)
if (!big.length) return { skipped: Object.fromEntries(small.map(d => [d.key, d.items.length])), reason: `every requested domain is below the ${MIN_ITEMS}-item workflow threshold — use /refactor` }

const implementPrompt = d =>
  'Refactor pass on your surface (no feature spec). Read PIPELINE.md first. Add the missing tests ' +
  'FIRST (pin current behavior / cover the entry points), watch them pass, THEN refactor to clear each ' +
  'item. Preserve current public behavior unless an item marks it a bug. Migrations stay additive. ' +
  `Need the current state of your tree? Compute it yourself: git diff ${base} -- <your surface path>. ` +
  'Lint + format before handoff; return the handoff in the format your agent instructions define. ' +
  'Backlog items for YOUR surface (self-contained — clear exactly these, reading only the files they name):\n' +
  d.items.join('\n')

const verifyDomain = async (d, implHandoff) => {
  if (implHandoff == null) return { key: d.key, cleared: [], remaining: d.items, gatesGreen: false, failures: 'implementer died' }
  const s = byKey[d.key]
  const gateCmds = s ? [quiet(s), s.lint_quiet_cmd || (s.lint_cmd ? `${s.lint_cmd} 2>&1 | tail -40` : ''), s.typecheck_cmd]
    .filter(c => c && !String(c).startsWith('<')) : []
  let v = await agent(
    `Verify a cohorte refactor round for domain ${d.key}. 1. Run these gates, each redirected to ` +
    `specs/reports/refactor-verify.${d.key}.txt (append) — never print their output: ` +
    `${gateCmds.map(c => JSON.stringify(c)).join(' · ') || '(none declared — skip gates, gatesGreen=true)'}. ` +
    '2. For EACH backlog item below, open its file:line and check the prescribed fix actually landed. ' +
    'Return the item lines split into cleared / remaining (verbatim), gatesGreen, and one line per gate failure.\n' +
    'Items:\n' + d.items.join('\n'),
    { model: 'haiku', label: `verify:${d.key}`, phase: 'Verify', schema: VERIFY, effort: 'low' },
  )
  // One bounded retry: re-dispatch the implementer on what verification rejected.
  if (v && (v.remaining.length || !v.gatesGreen) && byKey[d.key]) {
    const retryItems = v.remaining.length ? v.remaining : d.items
    log(`${d.key}: ${v.remaining.length} item(s) remaining${v.gatesGreen ? '' : ' + red gates'} — one retry round`)
    await agent(
      implementPrompt({ key: d.key, items: retryItems }) + (v.failures ? `\nGate failures to clear too:\n${v.failures}` : ''),
      { agentType: byKey[d.key].agent, label: `retry:${d.key}`, phase: 'Refactor' },
    )
    v = await agent(
      `Re-verify domain ${d.key} after a retry round — same procedure as before (gates redirected to ` +
      `specs/reports/refactor-verify.${d.key}.txt, per-item file:line check, verbatim cleared/remaining lines).\n` +
      'Items:\n' + retryItems.join('\n'),
      { model: 'haiku', label: `reverify:${d.key}`, phase: 'Verify', schema: VERIFY, effort: 'low' },
    )
  }
  return { key: d.key, ...(v || { cleared: [], remaining: d.items, gatesGreen: false, failures: 'verifier died' }) }
}

// ── Phase 2 — `shared` first, alone (every slice imports the contract pkg) ───
const results = []
const shared = big.find(d => d.key === 'shared')
if (shared) {
  phase('Shared')
  const handoff = await agent(
    `Refactor the shared contract package (${contractPath || 'the tree outside every surface'}) of this ` +
    'cohorte project — normally lead-owned, so: additive changes only, never break a shape a surface ' +
    'imports (grep consumers before changing any export), migrations stay additive, lint + format before ' +
    'handoff. Clear exactly these open backlog items (self-contained; read only the files they name):\n' +
    shared.items.join('\n'),
    { label: 'refactor:shared', phase: 'Shared' },
  )
  results.push(await verifyDomain(shared, handoff))
}

// ── Phases 3+4 — the other domains in parallel, each verified as it lands ────
const rest = big.filter(d => d.key !== 'shared' && byKey[d.key])
for (const d of big) {
  if (d.key !== 'shared' && !byKey[d.key]) log(`Skipping ${d.key} — no matching surface in PIPELINE.md`)
}
const restResults = await pipeline(
  rest,
  d => agent(implementPrompt(d), { agentType: byKey[d.key].agent, label: `refactor:${d.key}`, phase: 'Refactor' }),
  (handoff, d) => verifyDomain(d, handoff),
)
results.push(...restResults.filter(Boolean))

// ── Phase 5 — tick the cleared items ─────────────────────────────────────────
phase('Tick')
const clearedAll = results.flatMap(r => r.cleared)
if (clearedAll.length) {
  await agent(
    'In specs/refactor-backlog.md flip EXACTLY these open `- [ ]` item lines to `- [x]` (match verbatim, ' +
    'leave every other line untouched), then return the single word done:\n' + clearedAll.join('\n'),
    { model: 'haiku', label: 'tick-backlog', effort: 'low' },
  )
}

return {
  domains: Object.fromEntries(results.map(r => [r.key, {
    cleared: r.cleared.length, remaining: r.remaining.length, gatesGreen: r.gatesGreen,
  }])),
  skippedSmall: Object.fromEntries(small.map(d => [d.key, d.items.length])),
  stillOpen: results.flatMap(r => r.remaining.map(line => `[${r.key}] ${line}`)).slice(0, 15),
  next: results.some(r => r.remaining.length || !r.gatesGreen)
    ? 'items remain — finish them with the conversational /refactor <domain>'
    : 'all dispatched domains clean — optionally close with one final /audit',
}

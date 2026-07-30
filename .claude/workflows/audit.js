// cohorte — /audit as a deterministic workflow (opt-in; the conversational
// /audit command remains the default path and the fallback).
//
// Invoke with args = {target: "<path or domain>"} (optional — default whole repo).
//
// Shape (SCHEMA.md §Workflows): profile via profile-reader (phase 0), the
// mechanical gates staged to disk by one haiku agent, then ONE auditor per
// domain (each surface + `shared`) running concurrently — the runtime caps
// concurrency at ~16, extra domains queue — and a merge phase that writes the
// prioritized specs/refactor-backlog.md. Only the summary comes back.

export const meta = {
  name: 'cohorte-audit',
  description: 'Audit the codebase against PIPELINE.md: mechanical gates, one auditor per domain in parallel, prioritized refactor backlog',
  whenToUse: 'Only when the human explicitly asks for the audit workflow. args = {target: "<path or domain>"} — omit for the whole repo.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Gates', detail: 'format/lint/typecheck/tests → specs/reports/audit-gates.txt', model: 'haiku' },
    { title: 'Audit', detail: 'one review-in-audit-mode agent per domain (concurrent, runtime-capped ~16)' },
    { title: 'Backlog', detail: 'merge + write specs/refactor-backlog.md', model: 'haiku' },
  ],
}

const target = (typeof args === 'string' ? args.trim() : args && args.target) || ''

const PROFILE = { type: 'object', additionalProperties: true }

const GATES = {
  type: 'object', required: ['failures'], additionalProperties: false,
  properties: {
    failures: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', required: ['file', 'line', 'kind', 'summary'], additionalProperties: false,
        properties: {
          file: { type: 'string' }, line: { type: 'integer' },
          kind: { enum: ['lint', 'format', 'type', 'test'] },
          summary: { type: 'string', description: 'one line, no output excerpts' },
        },
      },
    },
    overflow: { type: 'integer', description: 'failures beyond the 40-item cap' },
  },
}

const BACKLOG = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items: {
      type: 'array', maxItems: 30,
      items: {
        type: 'object', required: ['severity', 'file', 'line', 'kind', 'fix'], additionalProperties: false,
        properties: {
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' }, line: { type: 'integer' },
          kind: { enum: ['rule', 'tdd', 'lint', 'format', 'type', 'security'] },
          fix: { type: 'string', description: 'one concrete change, one line, no code excerpts' },
        },
      },
    },
    overflow: { type: 'integer' },
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
const cmds = profile.commands || {}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
const quiet = (q, full) => (q && !String(q).startsWith('<') ? q : full ? `${full} 2>&1 | tail -40` : '')
const scope = target || 'the whole repo'

// ── Phase 1 — mechanical gates, staged to disk ───────────────────────────────
phase('Gates')
const gateCmds = [
  cmds.format ? `${cmds.format} --check` : '',
  quiet(cmds.lint_quiet, cmds.lint),
  cmds.typecheck,
  quiet(cmds.test_quiet, cmds.test),
].filter(c => c && !String(c).startsWith('<'))
const gates = await agent(
  `Run the cohorte audit's mechanical gates, scoped to ${scope}. Commands (adapt the format one to the ` +
  `project's check mode if --check is wrong): ${gateCmds.map(c => JSON.stringify(c)).join(' · ')}.\n` +
  'Redirect EVERY command\'s output into specs/reports/audit-gates.txt (append, `cmd >> file 2>&1`) — ' +
  'never print it — and keep going after failures (this is an inventory, not a gate to pass). Then grep ' +
  'the file and return each failure as file/line/kind/one-line summary, capped at 40 (set overflow for the rest).',
  { model: 'haiku', label: 'gates', schema: GATES, effort: 'low' },
)
const mech = (gates && gates.failures) || []
log(`Mechanical failures: ${mech.length}${gates && gates.overflow ? ` (+${gates.overflow} overflow)` : ''}`)

// ── Phase 2 — one auditor per domain, concurrent ─────────────────────────────
// Domains = every surface + `shared` (contract package + anything outside the
// surface trees). The runtime caps concurrent agents (~16); more domains queue.
phase('Audit')
const domains = surfaces.map(s => ({ key: s.key, path: s.path }))
  .concat([{ key: 'shared', path: (profile.contract && profile.contract.path) || '(everything outside the surface trees)' }])
  .filter(d => !target || target === d.key || String(d.path).startsWith(target) || target.startsWith(String(d.path)))
if (!domains.length) return { error: `target "${target}" matches no surface/domain` }

const audited = await parallel(domains.map(d => () => agent(
  'Audit a target against PIPELINE.md (no spec — audit mode, per your agent instructions). Check ' +
  'conventions for the domain\'s surface, TDD coverage (untested entry points / modules), and — if the ' +
  'profile enables them — mobile-first + design-system usage. Mechanical findings are already staged: ' +
  'read specs/reports/audit-gates.txt and fold the ones in your domain in. Return the prioritized items, ' +
  'capped at 30, one line each, no code excerpts. — Variable slots: domain: ' +
  `${d.key} · tree: ${d.path}${target ? ` · human-requested target: ${target}` : ''}`,
  { agentType: 'review', label: `audit:${d.key}`, schema: BACKLOG },
).then(r => r && { key: d.key, items: r.items, overflow: r.overflow || 0 })))
const perDomain = audited.filter(Boolean)

// ── Phase 3 — merge + write the backlog ──────────────────────────────────────
phase('Backlog')
const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const body = ['# Refactor backlog', '', `> Generated by the cohorte-audit workflow (scope: ${scope}).`]
let total = 0
for (const d of perDomain) {
  const items = [...d.items].sort((a, b) => SEV[a.severity] - SEV[b.severity])
  total += items.length
  body.push('', `## ${d.key}`, '')
  for (const it of items) body.push(`- [ ] ${it.severity} · ${it.file}:${it.line} · ${it.kind} · ${it.fix}`)
  if (d.overflow) body.push(`- [ ] (+${d.overflow} more beyond the cap — re-audit ${d.key} after this pass)`)
}
await agent(
  `Write EXACTLY this content to specs/refactor-backlog.md (overwrite), then return the single word done:\n<<<BACKLOG\n${body.join('\n')}\nBACKLOG`,
  { model: 'haiku', label: 'write-backlog', effort: 'low' },
)

return {
  backlog: 'specs/refactor-backlog.md',
  mechanicalFailures: mech.length,
  domains: Object.fromEntries(perDomain.map(d => [d.key, d.items.length + (d.overflow || 0)])),
  total,
  top: perDomain.flatMap(d => d.items.map(it => ({ ...it, domain: d.key })))
    .sort((a, b) => SEV[a.severity] - SEV[b.severity]).slice(0, 10)
    .map(it => `[${it.severity}] ${it.domain} · ${it.file}:${it.line} — ${it.fix}`),
  next: 'refactor a domain with /refactor <domain> (or the refactor workflow for big domains)',
}

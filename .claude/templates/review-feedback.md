# REVIEW REPORT

<!-- Emitted-report shape. Everything in an HTML comment is guidance — do NOT emit it.
     Verdict rules live in the review agent's instructions (SHIP = no CRITICAL/security;
     REVISE = ≥1 CRITICAL; BLOCK = security vulnerability). -->

feature_id: <feature_id>
Feature branch: <feature_branch_prefix><feature_id>
Commit SHA: <first 12 chars>

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 0     |
| MEDIUM   | 0     |
| LOW      | 0     |

Verdict: <SHIP | REVISE | BLOCK>

## Findings

<!-- Every finding self-sufficient for a stateless agent; order by severity; "None." if none.
     The line format pastes straight into the spec's `## Remediation`. -->

- **[CRITICAL]** `<surface.path>/...:42` · spec-violation · <what's wrong vs spec §X> → **Fix:** <concrete change>
- **[HIGH]** `<path>:88` · quality · <issue> → **Fix:** <concrete change>
- **[BLOCK/security]** `<path>:line` · security · <vuln> → **Fix:** <concrete change>

## Notes

<!-- ONLY the RBAC / mobile-first assessment when the profile enables them; omit the section
     otherwise. Never list things verified clean. -->

# HANDOFF — <surface> · `<feature_id>`

<!-- Keep it tight: the lead only acts on mismatches, test failures, remediation ticks, and TODOs.
     Never list files one by one — the lead has `git diff --stat`. Never paste code excerpts —
     a file:line reference is enough, the code is on disk. One line per item. -->

## Summary

<2–4 lines: what you built and the approach>

## Migrations / schema (only if any)

- `<name>` — <additive change>

## Tests

- Run: <this surface's test_cmd> · result: <pass/fail + counts>

## Contract mismatches / assumptions

<none, or describe — NEVER edit the contract; report here instead>

## Remediation addressed (fix loops only)

- <which `## Remediation` items you fixed, by file:line>

## TODO / not done

- <anything deferred, blocked, or out of scope — or "none">

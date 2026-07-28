# Cohorte Dashboard — a Francois plugin

Renders your [cohorte](https://github.com/TheBidouilleAgency/cohorte) fleet in a
Francois pane: tracked projects, `/doctor` health, spec counts, and how far each
project's pipeline core has drifted from the latest release.

```
COHORTE                              2 · [6]
core                       1.0.0  current
──────────────────────────────────────────
Francois        12/1/0  21 specs  current ›
api              8/0/2   4 specs  3 behind ›
```

## What it needs

The plugin reads the dashboard's **JSON API**; it does not and cannot run the
dashboard's React app. Start the server yourself:

```sh
cohorte dashboard          # binds 127.0.0.1:4317
```

Until it is running the pane says so and offers `retry`. A plugin has no way to
spawn a process — that is the sandbox working as designed, not a gap.

## Install

Plugins install from GitHub or npm, so publish this directory (or point Francois
at a repo that contains it):

1. `⌘K` → **Manage plugins**
2. paste the repo, `⏎`, read the consent card, **Install**
3. pick **Enabled in:** — install is not activation

Then set **dashboard port** if you run `cohorte dashboard --port=N`.

## What it can do

One capability: `network`, allowlisted to `127.0.0.1`. It has **no** `readState`
and **no** `driveSessions` — it cannot see your sessions, your diffs or your
projects, and it cannot put text into a session.

| Endpoint | Used for |
| --- | --- |
| `GET /api/fleet` | the project list, freshness, health |
| `GET /api/versions` | the global core banner |
| `GET /api/state?project=` | the drill-in detail (`open-project`) |

It never calls `POST /api/action` — the endpoint that runs `install`, `update`,
`reset` and headless `claude`. A panel that refreshes every 30 seconds should not
hold a trigger for those, and the sandbox's 15 s fetch timeout could not follow
their streamed output anyway.

## Worth knowing about the allowlist

Francois matches `capabilities.network.hosts` on the **host only** — there is no
port in the grant. Consenting to `127.0.0.1` therefore reaches *every* service on
your loopback interface, not just cohorte's. This plugin only ever builds URLs
from its own `port` setting (there is a test pinning that), but the grant you give
it is broader than what it uses.

## Keyboard

`6`–`9` focus the first four plugin panes. Inside the pane, `↑`/`↓` move the
selection and `⏎` opens the selected project's detail.

## Tests

`src-tauri/src/plugin/cohorte.rs` runs **this file** through the real QuickJS
isolate against a stubbed dashboard, and validates the output with the same
`PanelSpec` validator the app uses:

```sh
cd src-tauri && cargo test plugin::cohorte
```

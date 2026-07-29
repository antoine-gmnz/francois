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
spawn a process — that is the sandbox working as designed, not a gap, and it is
why nothing here starts the server for you.

## Why there is no COHORTE tab

A plugin *can* contribute a main tab that frames a web page
(`capabilities.webTab` + `contributes.tab`), and cohorte's React cockpit is
exactly the kind of thing that would suit one. This plugin does not contribute
one, for a reason worth stating rather than leaving as an omission:

**a framed tab must be `https:`, loopback included** (FR-82). `francois.fetch`
is allowed to reach `http://127.0.0.1` because its response is inert bytes
handed to the isolate; a framed page *executes* next to the app, and a plaintext
loopback origin is one any other process on the machine can impersonate. Since
`cohorte dashboard` serves plain HTTP on 127.0.0.1, it cannot be framed — so the
pane renders the fleet from the JSON API instead, and the cockpit stays in a
browser where it belongs.

The tab is not a way around the sandbox in any case: `francois.*` exists only
inside the isolate, the frame is opened cross-origin with no IPC, and its URL is
fixed in the manifest at the moment you consent to it — a plugin cannot repoint
its tab afterwards.

## Install

Plugins install from GitHub or npm, so publish this directory (or point Francois
at a repo that contains it):

1. `⌘K` → **Manage plugins**
2. paste the repo, `⏎`, read the consent card, **Install**
3. pick **Enabled in:** — install is not activation

Then set **dashboard port** if you run `cohorte dashboard --port=N`.

## What it can do

Three capabilities since **1.1.0**: `network` allowlisted to `127.0.0.1`,
`readState`, and `driveSessions`.

| Endpoint | Used for |
| --- | --- |
| `GET /api/fleet` | the project list, freshness, health |
| `GET /api/versions` | the global core banner |
| `GET /api/state?project=` | the drill-in detail (`open-project`) |

It never calls `POST /api/action` — the endpoint that runs `install`, `update`,
`reset` and headless `claude`. A panel that refreshes every 30 seconds should not
hold a trigger for those, and the sandbox's 15 s fetch timeout could not follow
their streamed output anyway.

### About `driveSessions`

It reads as the alarming one and is not: it **cannot send anything**.
`francois.session.prompt()` only mints a *request*, which appears in the session
transcript as an Approve/Deny card showing the exact text. You send it. The
plugin is never told what you decided.

That is what makes routing cohorte's work through a session reasonable while
`POST /api/action` still is not: one asks you to read a prompt and press approve,
the other executes code on your machine with no card in between.

Rows the dashboard reports as **failing** get a `⚑ fix` action; rows that are
**behind** get `↑ update`. Both compose a prompt naming that project and hand it
to a session open on it — preferring an idle one, and refusing to fall back to an
unrelated session if none is open. A healthy, current project offers neither,
because the prompt would have nothing to say.

`readState` is what makes that targeting possible: it lists sessions so the
plugin can match one to the project's directory.

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

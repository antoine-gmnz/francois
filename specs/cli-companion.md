---
id: cli-companion
title: CLI companion (the `francois` CLI)
status: frozen
created: 2026-07-18
depends_on: [session-engine]
---

# CLI companion (the `francois` CLI)

## 1. Summary

A `francois` command-line tool, shipped alongside the app and put on `PATH` by the installer, that talks to the **running** Francois app over a local, per-user socket and prints read-only session/agent state as plain-text tables or JSON. It lets a user check on their sessions and subagents from any terminal — including the app's own SHELL tab, per the mock's `francois agents --status` example — without switching to the app window. v1 is strictly read-only: no session/agent mutation travels over this channel yet.

## 2. Goals & non-goals

- **Goals**:
  - Define a small, versioned request/response protocol (`contract/cli-companion.ts`) between the `francois` CLI process and the app's Rust core, transported over a named pipe (Windows) or unix domain socket (macOS/Linux).
  - Ship three read-only commands — `francois version`, `francois sessions`, `francois agents --status` — that report live state pulled directly from session-engine.
  - Resolve "the current session" from the invoking shell's working directory, so the CLI is a natural companion to run from inside a project directory.
  - Reproduce the exact table formatting shown in the mock's SHELL tab (`Claude Terminal.dc.html`, "clyde agents --status" → read as "francois agents --status").
  - Fail predictably and cheaply when the app isn't running (250ms connect budget, one retry for the "starting up" race).
- **Non-goals**:
  - Any mutating command (new session, kill agent, attach MCP server, run skill, send a message). The protocol (`CliMethod`) is designed to grow to cover these later, but v1's server only implements the three read methods below. Deferred to a future revision of this spec.
  - Installer/packaging mechanics: how the `francois` binary gets onto `PATH` per OS (installer PATH registration, symlink, `.cmd` shim, etc.) is a build/release concern, not this spec. This spec defines the binary's runtime behavior and the wire protocol only.
  - Authentication/authorization beyond OS file permissions. The transport is local-only, single-user, no network listener, no tokens.
  - Color output, `--no-color`, `FORCE_COLOR`. v1 prints plain text only, unconditionally.
  - Shell completions, man pages, full `--help` docs. Only a one-line usage message on argv errors.

## 3. User stories / flows

1. **Quick status check from any terminal.** User has Francois open with `acme-api` running. In a separate terminal (or the app's own SHELL tab), from inside `~/projects/acme-api`, they run `francois agents --status`. The CLI resolves the session from `cwd`, prints the agents table, exits 0.
2. **Explicit session, from anywhere.** User is in an unrelated directory and knows the session id. They run `francois agents --status --session <id>`; the CLI skips cwd resolution and queries that session directly.
3. **Scripting.** User pipes `francois sessions --json | jq '.sessions[] | select(.status=="error")'` to find failed sessions from a shell script; `--json` guarantees stable, parseable output on stdout with nothing else mixed in.
4. **App not running.** User runs any `francois` command before launching the app. The CLI fails fast (≤ ~700ms worst case) with a clear message and exit code 1, so scripts can branch on it.
5. **App mid-startup.** User launches the app and, in the same instant, runs a `francois` command from a script. The CLI detects the "socket exists but nothing's listening yet" race, retries once, and either succeeds moments later or reports `APP_NOT_RUNNING`.
6. **Version check.** User runs `francois version` to confirm which app build and protocol version they have (useful when filing a bug or checking a stale global install after an app update).

## 4. Functional requirements

**Transport & server lifecycle**

- **FR-1** Addressing: Windows — named pipe `\\.\pipe\francois-<username>`, where `<username>` is `os.userInfo().username` used verbatim (Windows pipe names allow it; no escaping needed). macOS/Linux — unix domain socket at `$XDG_RUNTIME_DIR/francois.sock` if `XDG_RUNTIME_DIR` is set and that directory exists and is writable by the current user; otherwise `~/.francois/francois.sock` (creating `~/.francois` with mode `0700` if missing).
- **FR-2** Permissions: the unix socket file is created with mode `0600` (owner rw only). No TCP/network listener exists anywhere in this feature.
- **FR-3** Stale socket cleanup: on app launch, before binding, the Rust core `unlink`s any pre-existing file at the unix socket path (ignoring `ENOENT`). Named pipes need no such cleanup — the OS releases the pipe object when the previous server process exits.
- **FR-4** Single-instance lock: the Rust core must hold the app's single-instance lock (via the Tauri single-instance plugin) before starting the CLI server. A second app instance that fails to acquire the lock quits without starting a CLI server and without touching the socket/pipe path — it can never clobber the first instance's listener.
- **FR-5** Framing: every frame (`CliHello`, `CliRequest`, `CliResponse`) is exactly one line of UTF-8 JSON terminated by `\n`. No frame's JSON encoding may contain a literal newline.
- **FR-6** Connection lifecycle ("one request per connection"): the client (a) connects, (b) writes one `CliHello` frame immediately followed by one `CliRequest` frame, (c) reads exactly one response line, (d) closes the connection. The server reads at most one `CliHello` + one `CliRequest` per connection, writes exactly one response frame, then closes the connection. No keep-alive, no pipelining.
- **FR-7** Handshake: the server reads the first line as `CliHello`. If `hello.protocol !== CLI_PROTOCOL_VERSION`, it writes `{ id: -1, error: { code: 'INVALID_INPUT', message: 'protocol version mismatch: client <hello.protocol>, app <CLI_PROTOCOL_VERSION>' } }` and closes the connection without reading further. Otherwise it proceeds to FR-8.
- **FR-8** Request parsing: the server reads the second line and `JSON.parse`s it. If parsing fails, or the value isn't an object with a numeric `id` and a `method` string, the server writes `{ id: -1, error: { code: 'INVALID_INPUT', message: 'malformed request' } }` and closes the connection (this is the "malformed JSON" case). Otherwise it dispatches per FR-9–FR-13 and writes one `CliResponse` echoing the request's real `id`.

**Methods**

- **FR-9** `version`: no params. Returns `VersionResult { app, protocol }` where `app` is the running app's semantic version (from the Tauri app's package info) and `protocol` is `CLI_PROTOCOL_VERSION`. Always succeeds.
- **FR-10** `sessions.list`: no params. Returns `SessionsListResult { sessions: SessionMeta[] }` — every session session-engine currently tracks, in the engine's own (creation) order, read live from its in-memory state. No filtering, no pagination in v1.
- **FR-11** `agents.status`: params `AgentsStatusParams { sessionId?: SessionId; cwd?: string }`.
  - If `sessionId` is present, resolve by exact id lookup; no such session → `SESSION_NOT_FOUND`.
  - Else if `cwd` is present, resolve per FR-12; no match → `SESSION_NOT_FOUND`.
  - Else (neither present) → `INVALID_INPUT` (`'agents.status requires sessionId or cwd'`).
  - On success, returns `AgentsStatusResult { agents: AgentInfo[] }` — every agent belonging to the resolved session, in session-engine's own (dispatch) order, read live.
- **FR-12** cwd resolution: given absolute path `cwd`, compare against every tracked session's `cwd` using platform-appropriate normalization (case-insensitive on Windows/macOS, case-sensitive on Linux): (1) exact match wins outright; (2) else, among sessions whose `cwd` is a proper ancestor of the given path (`cwd === session.cwd || cwd.startsWith(session.cwd + path.sep)`), pick the one with the **longest** `session.cwd` (most specific/deepest match); (3) else `SESSION_NOT_FOUND`.
- **FR-13** Unknown method: if `method` parses but isn't a value of `CliMethod` this server build knows, respond `{ id: request.id, error: { code: 'INVALID_INPUT', message: 'unknown method: <method>' } }` — using the request's real `id`, since the frame itself was well-formed (this is the forward-compat path for a newer CLI talking to an older app).

**Client behavior**

- **FR-14** Connect: 250ms connect timeout. `ENOENT` (no socket/pipe present at all) → immediately `APP_NOT_RUNNING`, no retry. `ECONNREFUSED` (path exists, nothing listening — stale file or app mid-bind) → wait 200ms, retry the connection once (same 250ms timeout); a second failure of either kind → `APP_NOT_RUNNING`.
- **FR-15** Response timeout: after a successful connect + write, wait up to 5000ms for the single response line; on timeout, close the connection and exit 2 with `francois: did not respond in time` on stderr.
- **FR-16** `francois version`: no arguments (any extra arg → usage error, exit 2). Default output: `francois <app> (protocol <protocol>)`. `--json` prints `JSON.stringify(VersionResult, null, 2)`.
- **FR-17** `francois sessions [--json]`: calls `sessions.list` with no params. Default output: headerless table, columns `name`, `status`, `model.label`, `cwd` (§8). `--json` prints `JSON.stringify(SessionsListResult, null, 2)`. Any other flag → usage error, exit 2.
- **FR-18** `francois agents --status [--session <id>] [--json]`: `--status` is required — its absence is a usage error, exit 2 (the flag shape mirrors the mock's literal `agents --status` invocation). If `--session <id>` is given, params = `{ sessionId: id }`; otherwise params = `{ cwd: process.cwd() }`. Default output: headerless table, columns `name`, `status`, then a result column that is `${progress}%` when `status` is `running`/`idle`, or `task` when `status` is `done`/`error` (§8). `--json` prints `JSON.stringify(AgentsStatusResult, null, 2)`. `--session` given without a value, or any other unrecognized flag → usage error, exit 2.
- **FR-19** Exit codes: `0` on success (including a call that resolves to zero rows). `1` exclusively for `APP_NOT_RUNNING`, stderr message `francois is not running — start the app first`. `2` for everything else — usage errors, any other `AppError` (stderr: `francois: <error.message>`), response timeout (FR-15), and transport-level errors (e.g. permission denied opening the socket). All error output goes to stderr; stdout carries only the requested table/JSON on success.
- **FR-20** No mutation: v1's server implements only `version`, `sessions.list`, `agents.status`; it performs no writes to session-engine state and rejects any other method per FR-13. Mutating methods are explicitly future work behind this same envelope (see Non-goals).

## 5. API contract

This feature has no Tauri command/event channel — the frontend is not involved. The "IPC" here is the local pipe/socket protocol between the external `francois` CLI process and the app's Rust core (which already holds session-engine's live state in-process, so no additional core-internal channel is needed to serve it). The exact contents of `contract/cli-companion.ts`:

```ts
// contract/cli-companion.ts
import type { AppError, SessionId, SessionMeta, AgentInfo } from './common';

/** Wire protocol major version. Bump only on breaking changes to CliHello,
 *  CliRequest, CliResponse, or CliMethod semantics. Additive, backward-compatible
 *  new methods do NOT require a bump (see FR-13). */
export const CLI_PROTOCOL_VERSION = 1;

/** First frame on every connection, sent before the CliRequest frame. */
export interface CliHello {
  protocol: number; // CLI_PROTOCOL_VERSION the client was built with
}

export type CliMethod = 'version' | 'sessions.list' | 'agents.status';

export interface CliRequest {
  id: number; // CLI always sends 1 (exactly one request per connection — FR-6)
  method: CliMethod;
  params?: unknown;
}

export interface CliResponse {
  id: number; // echoes CliRequest.id, or -1 for a hello-rejection / malformed-request error (FR-7, FR-8)
  result?: unknown;
  error?: AppError;
}

// ---- version ----
export interface VersionResult {
  app: string;      // running app's semantic version, e.g. '0.5.0'
  protocol: number;  // CLI_PROTOCOL_VERSION of the running app
}

// ---- sessions.list ----
export interface SessionsListResult {
  sessions: SessionMeta[];
}

// ---- agents.status ----
export interface AgentsStatusParams {
  sessionId?: SessionId; // exact match; takes priority over cwd (FR-11)
  cwd?: string;           // absolute path; resolved per FR-12
}

export interface AgentsStatusResult {
  agents: AgentInfo[];
}

/** Documents the params/result pairing per method; not sent over the wire. */
export interface CliMethodMap {
  version: { params: undefined; result: VersionResult };
  'sessions.list': { params: undefined; result: SessionsListResult };
  'agents.status': { params: AgentsStatusParams; result: AgentsStatusResult };
}
```

Error codes this feature can return (all from `ErrorCode` in `contract/common.ts` — no feature-specific codes are added):

| Code | When |
|---|---|
| `APP_NOT_RUNNING` | Client can't reach the server at all (FR-14). Never appears inside a `CliResponse` — it's a client-side condition, since there's no connection to receive one over. |
| `INVALID_INPUT` | Protocol mismatch (FR-7), malformed request (FR-8), unknown method (FR-13), or `agents.status` called with neither `sessionId` nor `cwd` (FR-11). |
| `SESSION_NOT_FOUND` | `agents.status` given a `sessionId` that doesn't exist, or a `cwd` that resolves to no session (FR-11, FR-12). |
| `INTERNAL` | Unexpected server-side failure while reading session-engine state. |

Consumers of this contract: the Rust core's CLI server handler, and the `francois` CLI binary itself. Both are Rust, not frontend code — the CLI is a small Rust binary built from the same workspace, installed on `PATH` by the installer, and the app-side server is hosted by the Rust core.

## 6. Data & state

- No new persisted state. The server is a thin, stateless, read-only query layer over session-engine's existing in-memory `SessionMeta`/`AgentInfo` state (owned and mutated by session-engine, per that spec) — it never caches or snapshots that state beyond the lifetime of one request.
- The socket/pipe path (FR-1) is computed once at server start from OS + username; it is not persisted, except for the unix socket's filesystem entry, which can outlive a crashed process (hence FR-3's cleanup on next launch).
- The CLI process itself holds no config file, no cache, no session state between invocations — each invocation is a fresh connect → hello → request → response → exit.
- `CLI_PROTOCOL_VERSION` is compiled into both the app and the CLI binary from the same workspace, so they're in lockstep in the normal case. A mismatch (FR-7) only arises from a stale global `francois` install left over from a previous app version.

## 7. Edge cases & errors

| Scenario | Detection | CLI behavior |
|---|---|---|
| App not running (no socket/pipe) | `ENOENT` on connect | Exit 1, stderr: `francois is not running — start the app first` |
| App starting (socket file exists, nothing bound yet) | `ECONNREFUSED` on connect | Retry once after 200ms (FR-14); if it fails again, exit 1 as above |
| Two app instances launched | Second instance fails to acquire the single-instance lock | Second instance never starts a server or touches the socket path (FR-4); CLI always talks to the first instance, unaffected |
| Malformed JSON on the request line | Server `JSON.parse` fails or shape is invalid | Server replies `{ id: -1, error: { code: 'INVALID_INPUT', message: 'malformed request' } }`; CLI treats any `error` in the response as failure, exit 2 |
| Client protocol major mismatch | `hello.protocol !== CLI_PROTOCOL_VERSION` | Server replies `{ id: -1, error: { code: 'INVALID_INPUT', ... } }` before reading the request; CLI exit 2, stderr shows the server's message |
| Unknown method (forward compat) | `method` not in server's `CliMethod` | Server replies `{ id, error: { code: 'INVALID_INPUT', message: 'unknown method: …' } }`; CLI exit 2 |
| `--session <id>` doesn't exist | `agents.status` sessionId lookup misses | `SESSION_NOT_FOUND`; CLI exit 2, stderr: `francois: <error.message>` |
| cwd doesn't resolve to any session | FR-12 finds no ancestor match | `SESSION_NOT_FOUND`; CLI exit 2 |
| Session resolved but has zero agents | Normal `agents.status` success, empty array | Table mode: no lines printed; `--json`: `{"agents":[]}`; exit 0 |
| No sessions at all | Normal `sessions.list` success, empty array | Table mode: no lines printed; `--json`: `{"sessions":[]}`; exit 0 |
| Server doesn't answer in time | No response line within 5000ms (FR-15) | CLI closes the connection, exit 2, stderr: `francois: did not respond in time` |
| Socket file permission denied | `EACCES` on connect (e.g. corrupted permissions) | Exit 2, stderr: `francois: <system error message>` |
| Bad CLI invocation (missing `--status`, unknown flag, missing flag value) | Argv parse | Exit 2, one-line usage printed to stderr |

## 8. Design brief

### Screens / regions
No GUI surface — this feature's only rendered output is CLI stdout/stderr text, run from any terminal (including, but not limited to, the app's own SHELL tab). The mock's SHELL tab (`Claude Terminal.dc.html`, `shData` around the `clyde agents --status` lines — read "clyde" as "francois") is the literal reference for the `agents --status` table's exact spacing; this section is that spec, generalized to the `sessions` table too.

### Components
- **Table** (headerless): one row per item, columns left-aligned and space-padded except the last column.
- **JSON dump** (`--json`): `JSON.stringify(result, null, 2)` to stdout, nothing else.
- **Usage/error line**: single line to stderr, prefixed `francois: ` (except the two fixed messages in FR-19/FR-14 for `APP_NOT_RUNNING`, which are used verbatim to stay script-matchable).

### States
- **Table with rows**: as below.
- **Table with zero rows**: nothing printed to stdout; exit 0 (not an error — see §7).
- **Error**: nothing on stdout; one line on stderr; non-zero exit.

### Interactions
None — the CLI is non-interactive; it prints and exits. No prompts, no pager, no live-refresh in v1.

### Visual notes — table layout (the design)

No header row. No color, ever (v1 has no `--no-color`/`FORCE_COLOR` handling because there is no color to suppress). Column padding: for every column except the last, width = `max(length of that column's cell across all rows to print) + 3`, each cell left-padded with `String.prototype.padEnd(width, ' ')`; the last column is printed literally, unpadded. Rows print in the order the server returned them (session-engine's own order — no client-side sorting).

`agents --status` columns: `name`, `status`, then `${progress}%` (running/idle) or `task` (done/error). Worked example, reproducing the mock exactly:

```
test-writer     running   62%
code-reviewer   running   38%
dep-auditor     done      0 issues
```

(name column width 16 = `max(11,13,11)+3`; status column width 10 = `max(7,7,4)+3`.)

`sessions` columns: `name`, `status`, `model.label`, `cwd`. Same algorithm, illustrative example:

```
acme-api      running   Sonnet 4.5   ~/projects/acme-api
billing-svc   idle      Opus 4       ~/work/billing
docs-site     done      Haiku 4      ~/sites/docs
```

Rendering font is whatever the user's terminal is configured with — unlike the app's own SHELL tab (xterm.js, JetBrains Mono per PROJECT.md's design tokens), this CLI has no control over it and doesn't try to.

### Resize / responsive
The CLI never queries terminal width (no TTY-size detection in v1). Rows are printed at their natural length; a narrow terminal soft-wraps or the user scrolls horizontally — no truncation, no re-flowing, no `--width` flag.

## 9. Acceptance criteria

- [ ] Running `francois version` while the app is running prints `francois <app> (protocol <n>)` and exits 0; `--json` prints `VersionResult`. (FR-9, FR-16)
- [ ] Running `francois sessions` prints one headerless, padded row per tracked session in engine order; `--json` prints `SessionsListResult`. (FR-10, FR-17, §8)
- [ ] Running `francois agents --status` from inside a session's `cwd` (or a subdirectory of it) resolves that session via FR-12 and prints its agents table, with column 3 showing `NN%` for running/idle and `task` for done/error. (FR-11, FR-12, FR-18, §8)
- [ ] Running `francois agents --status --session <id>` resolves by exact id, bypassing cwd resolution. (FR-11, FR-18)
- [ ] `francois agents --status` without `--status` (i.e. `francois agents`) fails as a usage error, exit 2. (FR-18)
- [ ] Any command's `--json` flag produces `JSON.stringify(result, null, 2)` on stdout and nothing else. (FR-16, FR-17, FR-18)
- [ ] With the app not running (no socket/pipe present), any command exits 1 with `francois is not running — start the app first` on stderr within ~250ms. (FR-14, FR-19)
- [ ] With the socket file present but nothing listening (app mid-startup), the CLI retries once and then exits 1 with the same message if still unreachable. (FR-14)
- [ ] A second launched app instance never binds or removes the first instance's socket/pipe; CLI calls continue to reach the first instance. (FR-4)
- [ ] A malformed request line gets `{ id: -1, error: { code: 'INVALID_INPUT', ... } }` back from the server, and the CLI surfaces it as an exit-2 error. (FR-8)
- [ ] A `CliHello` with a mismatched `protocol` gets rejected before the request is read, via an `id: -1` error response. (FR-7)
- [ ] `agents.status` for a session with zero agents prints no rows and exits 0 (not an error); same for `sessions.list` with zero sessions. (§7)
- [ ] `agents.status` with an unknown `--session <id>` or an unresolvable `cwd` returns `SESSION_NOT_FOUND` and the CLI exits 2. (FR-11, FR-12, FR-19)

## Remediation

(Empty until a review returns findings.)

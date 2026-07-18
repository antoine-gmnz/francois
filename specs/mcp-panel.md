---
id: mcp-panel
title: MCP Servers Panel
status: frozen
created: 2026-07-18
updated: 2026-07-18
depends_on: [session-engine, app-shell]
---

# MCP Servers Panel

## 0. Amendment — scope-aware listing (supersedes FR-26 / §2's read-scope non-goal)

> This amendment reflects the shipped implementation and **supersedes** FR-26 and the §2 non-goal
> that said the panel never reads user/global MCP config. Ratified after review.

`mcp_list`/`mcp_detail` now **read** every scope the CLI sees for the session's cwd, matching
`claude mcp list`, merged with precedence **local > project > user**:

- **local** — `~/.claude.json` → `projects[<cwd>].mcpServers` (matched case-insensitively on Windows)
- **project** — `<cwd>/.mcp.json` (unchanged)
- **user** — `~/.claude.json` top-level `mcpServers`

`McpServerInfo` gains `scope` (`project|local|user`); each row shows a scope badge and the detail
popover shows the scope. **Writes stay project-only**: `mcp_attach` still writes `.mcp.json`, and
`mcp_detach` **refuses** a non-project-scope server with `MCP_ERROR` ("managed globally — remove it
with `claude mcp remove`"); the UI hides Detach for non-project rows. Runtime `mcp.update` events
carry no scope; the client preserves the scope `mcp_list` resolved. The empty-state copy is
`no MCP servers · attach one with ⌘K`.

## 1. Summary

The MCP servers panel is right-column pane **[4]** of the main window. For the currently active session it shows every configured MCP server as a status row (connected / connecting / error, with tool count or error detail), lets the user drill into a row for full detail plus Reconnect / Detach actions, and drives a two-step attach flow — pick from a curated registry (or define a custom server) — that writes into the session's project `.mcp.json` and asks session-engine to connect it. The panel is a thin, event-driven reflection of runtime state owned by session-engine; it never runs an MCP client itself.

## 2. Goals & non-goals

- **Goals**:
  - Reflect live MCP connection status for the active session (connected / connecting / error) with tool counts or error detail, staying in sync via `mcp.update` events regardless of who caused the change (this panel, the CLI companion, or session-engine itself on session start).
  - Let the user inspect a server's full detail (transport, command/url, tool count or full error) and Reconnect or Detach it, without leaving the app.
  - Let the user attach a new server, either from a curated registry entry (with a generated param form) or a fully custom definition, writing it into the session's project `.mcp.json`.
  - Support full keyboard operation of the panel, consistent with the app's pane-focus model (`app-shell`).
- **Non-goals**:
  - Editing user-scope (global) Claude Code MCP config — v1 writes **project-scope** `.mcp.json` only (see FR-26).
  - Managing servers for a session other than the currently active one; background sync for inactive sessions is `session-engine`'s concern.
  - A remote/searchable/publishable registry — v1's registry is a static curated JSON file shipped with the app (see §6).
  - Per-tool allow/deny lists or OAuth-style MCP authorization flows — v1's "secret" registry params cover the common static-API-key case only.
  - Editing an already-attached server's params in place — v1 offers Reconnect / Detach only; changing config is detach + re-attach.

## 3. User stories / flows

**A — Passive monitoring.** The user selects a session in the sidebar. The MCP panel hydrates (`francois:mcp:list`) and shows its servers. As `mcp.update` events stream in, a `connecting` server's dot and detail flip to `connected` with a live tool count, or to `error` with a short reason.

**B — Inspect via keyboard.** The user presses `4` to focus pane [4], then `↑`/`↓` to select the `puppeteer` row (error, red "timeout"). Pressing `⏎` opens the detail popover: full error message, transport/command, and Reconnect / Detach actions. `Esc` closes the popover; focus stays on pane [4].

**C — Inspect and detach via mouse.** The user clicks the `github` row. The popover opens showing transport (`stdio`), the resolved command, and `21 tools`. The user clicks **Detach**, sees an inline confirm ("detach github? …" with Confirm/Cancel), clicks **Confirm**; the row is removed and the popover closes.

**D — Attach from the palette.** The user presses `⌘K`, runs **Attach MCP server**. Step 1 lists registry entries (e.g. `linear`, `sentry`, `notion`, …) plus a trailing `custom…` row. The user picks `sentry`; step 2 renders its param form (e.g. a secret "Sentry DSN" field). They fill it in and submit; the flow closes, a new `sentry` row appears with a pulsing `connecting` state, then flips to `connected` or `error` as `mcp.update` events arrive.

**E — Attach a custom server.** Same entry points as D, but the user picks `custom…` in step 1; step 2 asks for name, transport (`stdio`/`http`), and the matching command or url field.

**F — Empty state.** A freshly opened session with no configured servers shows "no MCP servers · attach one with ⌘K" in place of rows; the user presses `⌘K` to start flow D.

## 4. Functional requirements

1. **FR-1**: On session activation (session becomes the app's active session), the panel invokes `francois:mcp:list` with the active `sessionId` and replaces its row list with the returned `McpServerInfo[]`.
2. **FR-2**: While a session is active, the panel consumes `francois:session:event` and, for every `mcp.update` event whose `sessionId` matches the active session, upserts `server` into the row list by `name` (replace if present, append if new, preserving row order — new servers append at the end).
3. **FR-3**: Switching the active session discards the previous session's rows, selection, open popover, and any open attach flow, then re-runs FR-1 for the newly active session.
4. **FR-4**: Each row renders a 8px status dot, the server name (12px, `#c4c7ce`), and a right-aligned detail string (10.5px), per `McpServerInfo.status`:
   - `connected` → dot `#7fa07a`, detail `"<toolCount> tools"` in `#868a93`.
   - `connecting` → dot `#c2b06a` pulsing, detail `"handshake…"` in `#868a93`.
   - `error` → dot `#c46b62`, detail = `errorMessage` in `#c46b62`.
5. **FR-5**: Only the `connecting` dot animates (`pulse 1.4s ease-in-out infinite`); `connected` and `error` dots are static.
6. **FR-6**: Rows are separated by a 1px `#1d1f25` bottom border; name and detail each truncate with ellipsis on overflow (single line, no wrap).
7. **FR-7**: When pane [4] is focused, `↑`/`↓` move a single-row selection cursor within the current list, clamped at the first/last row (no wrap); selection resets to the first row (or none, if empty) whenever the list is replaced (FR-1/FR-3).
8. **FR-8**: When pane [4] is focused, `⏎` opens the detail popover for the selected row.
9. **FR-9**: Clicking a row selects it and opens its detail popover in the same action.
10. **FR-10**: Opening the detail popover invokes `francois:mcp:detail` with `{ sessionId, name }` for the target row and renders a loading state until it resolves.
11. **FR-11**: The detail popover renders, on successful fetch: server name, status (dot + label), transport, the resolved `command` (stdio) or `url` (http), and either the tool count (`connected`) or the full `errorMessage` (`error`) — unlike the row, the popover never truncates the error text.
12. **FR-12**: The detail popover offers two actions: **Reconnect** and **Detach**.
13. **FR-13**: **Reconnect** invokes `francois:mcp:reconnect` with `{ sessionId, name }`. On success, the row optimistically flips to `connecting` (dot `#c2b06a` pulsing, detail `"handshake…"`) pending the next `mcp.update`. On failure, the row is left unchanged and the popover shows an inline error.
14. **FR-14**: **Detach** first shows an inline confirm (target name + "removes it from this project's `.mcp.json`", Confirm/Cancel) inside the popover; only on Confirm does it invoke `francois:mcp:detach` with `{ sessionId, name }`. On success, the row is optimistically removed and the popover closes. On failure, the row is kept, the confirm step resets, and the popover shows an inline error.
15. **FR-15**: `Esc` closes an open detail popover and returns focus to pane [4] without changing selection.
16. **FR-16**: When the active session's row list is empty (post-hydration, no attach flow open), the panel body renders "no MCP servers · attach one with ⌘K" (`#565a63`) centered, in place of rows.
17. **FR-17**: The panel header shows a live count and hotkey (`"<N> · [4]"`, `N` = current row count, `0` in the empty state) and a `+` affordance; both the command palette's **Attach MCP server** command and the header `+` open the attach flow at step 1.
18. **FR-18**: Attach step 1 invokes `francois:mcp:registry` and renders each returned `McpRegistryEntry` as a row (name + description), followed by a trailing synthetic `custom…` row that is always present regardless of registry fetch outcome. `↑`/`↓` selects, `⏎`/click advances to step 2 for the highlighted row, `Esc` closes the attach flow entirely.
19. **FR-19**: Step 2 for a registry entry renders one form field per `McpRegistryParam` (label, required marker, value input masked when `secret: true`). Submit is disabled until every `required` param has a non-empty value.
20. **FR-20**: Step 2 for `custom…` renders `name`, a `transport` toggle (`stdio` | `http`), and the matching `command` (stdio) or `url` (http) field. Submit is disabled until `name`, `transport`, and the transport-appropriate field are non-empty.
21. **FR-21**: `Esc` in step 2 returns to step 1 (selection preserved), not to step 1's registry re-fetch.
22. **FR-22**: On submit, the frontend builds an `McpAttachRequest`: for a registry entry, non-secret param values are substituted into `{key}` placeholders in `commandTemplate`/`urlTemplate` to produce `command`/`url`, secret param values are collected into `secretParams` keyed by `McpRegistryParam.key`, and `registrySource` is set to the entry's `name`; for `custom…`, `command`/`url` is taken verbatim from the form and `registrySource` is omitted. The frontend then invokes `francois:mcp:attach` with `{ sessionId, entry }`.
23. **FR-23**: Before enabling submit, the attach flow validates the chosen `name` is not already present in the panel's current row list for the active session (client-side check); the server still re-validates uniqueness and returns `INVALID_INPUT` on collision.
24. **FR-24**: On `francois:mcp:attach` success, the attach flow closes. The new server typically appears via the `mcp.update` (status `connecting`) that follows the write; if the panel does not observe it, the next full hydration (FR-1/FR-3) will still show it.
25. **FR-25**: On `francois:mcp:attach` failure (`INVALID_INPUT` or `MCP_ERROR`), the attach flow stays open at step 2 with an inline error message and the form values intact.
26. **FR-26**: Attach and Detach act only on the active session's **project-scope** `.mcp.json`; the panel never reads or writes user-scope (global) MCP config.
27. **FR-27**: Panel border/title follow the app-shell pane-focus convention: focused → border and title `#c8a15a`; unfocused → border `#2a2c33`, title `#868a93`. Pane hotkey is `4`.
28. **FR-28**: In-flight `francois:mcp:*` responses for a session that is no longer the active session are discarded on arrival (no state mutation).

## 5. API contract

Types below are additive to `contract/common.ts` and live in `contract/mcp-panel.ts`; they import shared types and never redefine them. `McpServerDetail` extends `McpServerInfo` (composition, not redefinition) to carry the extra fields the detail popover needs. No new `ErrorCode` members are required — this feature reuses `SESSION_NOT_FOUND`, `MCP_ERROR`, `INVALID_INPUT`, `INTERNAL` from `contract/common.ts`.

### 5.1 Types (`contract/mcp-panel.ts`)

```ts
import type { SessionId, Result, McpServerInfo } from './common';

// ---------- registry (v1: static curated JSON shipped with the app) ----------

export interface McpRegistryParam {
  key: string;          // placeholder name; matches a `{key}` token in commandTemplate/urlTemplate for non-secret params
  label: string;         // form field label
  required: boolean;
  secret?: boolean;      // true: masked input; value flows through McpAttachRequest.secretParams, never interpolated into command/url text
}

export interface McpRegistryEntry {
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  commandTemplate?: string; // present when transport === 'stdio'; may contain `{key}` tokens for non-secret params
  urlTemplate?: string;     // present when transport === 'http'; may contain `{key}` tokens for non-secret params
  params: McpRegistryParam[];
}

// ---------- attach ----------

export interface McpAttachRequest {
  name: string;                          // server name to write into .mcp.json; must be unique within the session's project config
  transport: 'stdio' | 'http';
  command?: string;                      // required when transport === 'stdio' — commandTemplate with non-secret {key} tokens substituted, or the verbatim custom command
  url?: string;                          // required when transport === 'http' — urlTemplate with non-secret {key} tokens substituted, or the verbatim custom url
  secretParams?: Record<string, string>; // values for params with secret: true, keyed by McpRegistryParam.key; engine applies as env vars (stdio) or request headers (http) — never written into command/url text
  registrySource?: string;               // McpRegistryEntry.name this request was built from; omitted for "custom…" entries
}

// ---------- detail (popover) ----------

export interface McpServerDetail extends McpServerInfo {
  transport: 'stdio' | 'http';
  command?: string; // present when transport === 'stdio' — the resolved command line as configured
  url?: string;      // present when transport === 'http'
}
```

### 5.2 IPC channels (frontend → core, `invoke`)

| Channel | Payload | Resolves | Error codes |
|---|---|---|---|
| `francois:mcp:list` | `{ sessionId: SessionId }` | `Result<McpServerInfo[]>` | `SESSION_NOT_FOUND` |
| `francois:mcp:detail` | `{ sessionId: SessionId; name: string }` | `Result<McpServerDetail>` | `SESSION_NOT_FOUND`, `MCP_ERROR` (server `name` not found in current config) |
| `francois:mcp:reconnect` | `{ sessionId: SessionId; name: string }` | `Result<void>` | `SESSION_NOT_FOUND`, `MCP_ERROR` |
| `francois:mcp:detach` | `{ sessionId: SessionId; name: string }` | `Result<void>` | `SESSION_NOT_FOUND`, `MCP_ERROR` |
| `francois:mcp:registry` | none | `Result<McpRegistryEntry[]>` | `INTERNAL` |
| `francois:mcp:attach` | `{ sessionId: SessionId; entry: McpAttachRequest }` | `Result<void>` | `SESSION_NOT_FOUND`, `INVALID_INPUT` (duplicate `name`, missing required param, malformed command/url), `MCP_ERROR` (config write or connect-dispatch failure) |

Note on `francois:mcp:detail`: the scope brief pins `francois:mcp:list` to `Result<McpServerInfo[]>` (row-level fields only: name/status/toolCount/errorMessage). The detail popover additionally needs transport and the resolved command/url, which `McpServerInfo` does not carry. `francois:mcp:detail` is this spec's single addition beyond the channels named in the feature brief, added so §5 is buildable with zero further questions per the spec template; it is lazy (fetched on popover open), read-only, and does not change `francois:mcp:list`'s shape.

### 5.3 Events consumed

`mcp-panel` does not own an event channel. It consumes the `mcp.update` member of `SessionEvent` (defined in `contract/common.ts`, emitted by `session-engine` on `francois:session:event`):

```ts
{ type: 'mcp.update'; sessionId: SessionId; server: McpServerInfo }
```

Per FR-2, only events whose `sessionId` matches the active session are applied.

## 6. Data & state

**Rust core** (implemented alongside `session-engine`'s per-session MCP integration; this feature adds no independent persistence):

- Source of truth is the session's working-directory project `.mcp.json` (config: name, transport, command/args or url) plus `session-engine`'s in-memory runtime status per server (connected/connecting/error, tool count, error message) for the active connection.
- `francois:mcp:list` / `francois:mcp:detail` read the merged view (config + runtime status) for the requested session; `detail` additionally surfaces transport and the resolved command/url.
- `francois:mcp:registry` reads a static curated JSON file bundled with the app (e.g. `resources/mcp-registry.json`), loaded once and cached in memory; no network call in v1.
- `francois:mcp:attach` merges the new entry into the session's project `.mcp.json` `mcpServers` map (creating the file if absent), then asks `session-engine` to (re)connect it — this connect step is asynchronous and reported via `mcp.update`, not via the `attach` response.
- `francois:mcp:detach` removes the entry from the session's project `.mcp.json` and asks `session-engine` to disconnect/stop that server.
- `francois:mcp:reconnect` restarts the connection for an already-configured server; it does not touch `.mcp.json`.
- The exact `.mcp.json` field shapes for `stdio` vs `http` entries (e.g. `command`/`args`/`env` vs `type`/`url`/`headers`) are `session-engine`'s responsibility, not defined by this contract.

**Frontend** (zustand slice owned by this feature, e.g. `useMcpPanelStore`):

- `servers: McpServerInfo[]` — the active session's current row list (re-hydrated on every session activation per FR-3; no cross-session cache is required by this spec).
- `selectedIndex: number | null` — local selection cursor for pane [4], reset per FR-7.
- `detail: { open: boolean; name: string | null; data: McpServerDetail | null; loading: boolean; error: AppError | null; confirmingDetach: boolean }`.
- `attach: { step: 'closed' | 'registry' | 'params'; registry: McpRegistryEntry[] | null; registryLoading: boolean; registryError: AppError | null; selected: McpRegistryEntry | 'custom' | null; selectedIndex: number; form: Record<string, string>; custom: { name: string; transport: 'stdio' | 'http'; command: string; url: string }; submitting: boolean; submitError: AppError | null }`.
- Derived: `serverCount` (header badge), `isEmpty` (drives FR-16).

No frontend state in this feature persists across app restarts; everything is re-derived from `francois:mcp:list`/`mcp.update` on the next activation.

## 7. Edge cases & errors

- **No servers configured** → empty state (FR-16), header count `0`; not an error.
- **`francois:mcp:list` → `SESSION_NOT_FOUND`** (session removed/stopped before hydration completes) → panel shows an inline "session unavailable" message in place of rows; re-attempts on the next activation of that session.
- **`francois:mcp:detail` → `SESSION_NOT_FOUND` / `MCP_ERROR`** (server removed concurrently, e.g. detached via the CLI companion between row-click and fetch resolving) → popover shows an inline error with a close affordance; the row list itself corrects on the next `mcp.update`/hydration.
- **`francois:mcp:reconnect` → `MCP_ERROR`** → no optimistic change was made prior to the response (FR-13 only flips state on success), so the row is left as-is; popover shows an inline error.
- **`francois:mcp:detach` → `MCP_ERROR`** → the row was not removed (FR-14 only removes on success); popover resets its confirm step and shows an inline error.
- **`francois:mcp:registry` → `INTERNAL`** → step 1 shows an inline error above the list; the trailing `custom…` row still renders and remains usable so attach is not fully blocked (FR-18).
- **`francois:mcp:attach` → `INVALID_INPUT`** (duplicate name, missing required param, malformed command/url after substitution) → step 2 stays open with an inline error; no config write occurred, no `mcp.update` follows.
- **`francois:mcp:attach` → `MCP_ERROR`** (e.g. `.mcp.json` write failure — read-only project directory, disk error) → step 2 stays open with an inline error; no config write occurred.
- **`francois:mcp:attach` succeeds but the subsequent connect fails** → this is not an attach failure (success means the config write succeeded); the flow closes per FR-24, and the new row surfaces via `mcp.update` with `status: 'error'` and its `errorMessage`, rendered exactly like any other error row.
- **Session switches away mid-flow** → any open popover or attach flow is discarded immediately (FR-3); responses for the now-inactive session that resolve afterward are discarded on arrival (FR-28).
- **Name collision race** (two attach requests for the same `name` in flight, e.g. from this panel and the CLI companion) → whichever the server processes second resolves `INVALID_INPUT`, surfaced per the case above.

## 8. Design brief

### Screens / regions

Owns the third `<section>` of the right column in `Claude Terminal.dc.html` — "MCP SERVERS", lines ~200–214 (`flex:0.95` inside the right-column flex container alongside AGENTS `flex:1.3` above and SKILLS `flex:1.05` below; header binds `titleMcp`/`ringMcp` to the `focused === 'mcp'` state, count badge is `"5 · [4]"`). The row markup (`mcps` list, lines 205–213) and its `dot`/`detail`/`detailFg`/`anim` mapping (`mcpData` → `mcps`, lines 358–369) are the row spec verbatim; this feature adds selection highlighting, the popover, and the attach overlay, none of which exist in the mock.

The attach flow's step-1/step-2 container reuses the **command palette** overlay's markup and tokens (lines 252–276: backdrop, 588px panel, header, list, footer hint bar) as its base component, restyled per step (see below). The detail popover is new UI, built from the same token language as the palette panel (dark floating surface, `#191b21`/`#34363f`) since the mock has no equivalent.

### Components

1. **Panel header** — title `MCP SERVERS` + count badge `"<N> · [4]"` + a `+` attach affordance.
2. **Server row** — status dot, name, right-aligned detail.
3. **Empty-state message** — centered single line.
4. **Detail popover** — header (name + status), body (transport, command/url, tool count or full error), inline detach-confirm state, action row (Reconnect / Detach).
5. **Attach overlay** — step 1 (registry list + `custom…`), step 2 (generated param form, or custom name/transport/command/url form).

### States

- **Row**: `connected` / `connecting` (pulsing) / `error`; each further has `default` and `selected` (keyboard cursor, mouse hover) sub-states.
- **Popover**: `loading`, `loaded`, `error`, `confirming-detach`.
- **Attach step 1**: `loading` (registry fetch in flight), `loaded` (list + `custom…`), `error` (inline error banner, `custom…` still usable), row `default`/`selected`.
- **Attach step 2**: `default`, `invalid` (submit disabled — required field(s) empty or name collision), `submitting`, `error` (server rejected).
- **Panel container**: `focused` / `unfocused` (pane-focus ring, per `app-shell`).

### Interactions

- Click anywhere on the panel header/body focuses pane [4] (matches the mock's `onClick="{{ focusMcp }}"` on the section root).
- `1`–`5` / click focus panes app-shell-wide; `4` focuses this pane.
- `↑`/`↓` move the row selection cursor when pane [4] is focused (FR-7); mouse hover previews the same highlight without moving the keyboard cursor.
- Click a row or press `⏎` on the selected row → opens the detail popover anchored to that row (FR-8/FR-9); `Esc` closes it (FR-15).
- Detach → inline confirm inside the popover, not a separate modal; Cancel returns to the default popover state.
- `⌘K` → **Attach MCP server**, or click the header `+` → opens the attach overlay at step 1, backdrop-click or `Esc` at step 1 closes it entirely; `Esc` at step 2 returns to step 1 (FR-21).
- Attach step 1: `↑`/`↓` + `⏎`/click to advance to step 2 for the highlighted entry, mirroring the palette's row navigation.
- Attach step 2: tab through fields; submit button disabled (dim) until valid; `⏎` in the last field submits when valid.
- Transitions: background-color changes on row hover/selection use a fast `120ms ease` fade (not present in the mock's static markup; matches the mock's overall crisp, non-bouncy motion language). Popover/overlay open uses no transition beyond mount (mock has no reference for this).

### Visual notes

- **Panel container**: background `#16171c`; border `1px solid` — `#c8a15a` when pane [4] is focused, `#2a2c33` otherwise; `border-radius: 5px`.
- **Header**: padding `9px 12px`; bottom border `1px solid #24262d`; title `11px`, `letter-spacing: 0.14em`, `font-weight: 700`, color `#c8a15a` (focused) / `#868a93` (unfocused); count badge `10px`, `#565a63`; `+` affordance `11px`, `#565a63` default / `#c8a15a` hover.
- **Row**: `display:flex; align-items:center; gap:9px; padding:7px 6px; border-bottom:1px solid #1d1f25`. Dot `8px × 8px`, `border-radius:50%`. Name `12px`, `#c4c7ce`, `flex:1`, single-line ellipsis. Detail `10.5px`, right-aligned, color per status (see FR-4).
- **Row selected**: background `#20222a` (matches the sidebar's selected-row treatment), full row width.
- **Status colors**: connected/done `#7fa07a` · error `#c46b62` · connecting `#c2b06a` · idle/dim text `#868a93` · faint `#565a63` · accent `#c8a15a`.
- **Pulse**: `@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }`, applied as `pulse 1.4s ease-in-out infinite` to the `connecting` dot only.
- **Empty state**: centered, `12px`, `#565a63`, vertically centered in the panel body.
- **Detail popover**: floating panel, width `280px`, background `#191b21`, border `1px solid #34363f`, `border-radius:6px`, shadow `0 20px 50px -15px rgba(0,0,0,0.75)`; anchored to the clicked/selected row, opening to the left of the right column when it would otherwise clip the window's right edge. Header: name `13px` `#dfe2e8` + status dot/label. Body rows: label `10px` `#565a63` uppercase-tracked, value `12px` `#c4c7ce` (command/url in monospace, `word-break: break-all`, no truncation — FR-11). Action row: `Reconnect` and `Detach` as text buttons, `11px`, `#a9adb6` default / `#dfe2e8` hover, `Detach` turns `#c46b62` once the inline confirm is showing.
- **Attach overlay** (step 1 and step 2 share the container): backdrop `rgba(6,7,9,0.62)`, panel `588px` wide, `background:#191b21`, `border:1px solid #34363f`, `border-radius:8px`, `box-shadow:0 30px 80px -20px rgba(0,0,0,0.85)`, top-anchored `118px` from the window top, centered horizontally — identical geometry to the command palette (lines 254 of the mock). Header row: `14px 16px` padding, bottom border `1px solid #24262d`, leading glyph `#c8a15a`, title `14px` `#d3d6dc`, trailing `esc` hint `10px` `#565a63`.
  - **Step 1 rows**: same list-row styling as palette commands (`10px 12px` padding, `border-radius:5px`, selected background `#26282f`, glyph `#c8a15a` when selected else `#868a93`, name `13px` `#dfe2e8`/`#c4c7ce`, description right-aligned `11px` `#565a63`); trailing `custom…` row uses a `+` glyph.
  - **Step 2 fields**: one row per param, label `11px` `#868a93` (`*` suffix in `#c8a15a` when required), input `background:#16171c`, `border:1px solid #24262d` default / `#c8a15a` focused, text `12.5px` `#c4c7ce`; `secret` inputs render as `password`-masked text. Submit button: full-width, `#c8a15a` text on `#26282f` background when enabled, `#565a63` on `#1b1d23` when disabled.
  - **Footer hint bar**: `9px 16px` padding, top border `1px solid #24262d`, `10px` `#565a63` hints — step 1: `↑↓ navigate` `⏎ select` `esc dismiss`; step 2: `⏎ submit` `esc back`.
- **Typography**: JetBrains Mono throughout, weights 400/500/700 per the mock's global font stack.

### Resize / responsive

- The right column has a fixed width (`336px`, from the grid's `grid-template-columns:264px 1fr 336px`); this panel's height flexes at `flex:0.95` among AGENTS (`1.3`) and SKILLS (`1.05`) in that column's flex layout and does not change width on window resize.
- The row list scrolls internally (`.scz`, 8px scrollbar, thumb `#2a2c33`, transparent track) once rows exceed the panel's height; header and empty-state stay fixed.
- Row name/detail never wrap — ellipsis on overflow (FR-6); the popover's command/url value does wrap (`break-all`) so nothing is hidden.
- The attach overlay's `588px` width and top-anchored position are fixed regardless of window size, matching the command palette's own fixed geometry.
- The detail popover repositions (flips left/right) to stay within the window bounds; it never resizes based on content length beyond its fixed `280px` width — long command/url text wraps within that width instead.

## 9. Acceptance criteria

- [ ] Selecting a session hydrates pane [4] from `francois:mcp:list` and shows one row per returned server (FR-1).
- [ ] A `mcp.update` event for the active session updates the matching row in place, or appends a new row, without a full re-fetch (FR-2).
- [ ] Switching sessions clears rows/selection/popover/attach state and re-hydrates for the new session (FR-3).
- [ ] Connected, connecting, and error rows render the exact dot colors, animation, and detail text/color specified in FR-4/FR-5 (verifiable against `#7fa07a`/`#c2b06a`/`#c46b62`).
- [ ] `↑`/`↓` move the row selection when pane [4] is focused, clamped at the ends (FR-7).
- [ ] `⏎` on a selected row and click on any row both open the detail popover via `francois:mcp:detail` (FR-8/FR-9/FR-10).
- [ ] The popover shows transport, command/url, and tool count or the **full**, untruncated error message (FR-11).
- [ ] Reconnect calls `francois:mcp:reconnect` and optimistically flips the row to `connecting` on success only (FR-13).
- [ ] Detach requires an inline confirm before calling `francois:mcp:detach`, and only removes the row on success (FR-14).
- [ ] `Esc` closes an open popover and returns focus to pane [4] (FR-15).
- [ ] An active session with zero servers shows the exact empty-state copy "no MCP servers · attach one with ⌘K" (FR-16).
- [ ] Both the `⌘K` "Attach MCP server" command and the panel header `+` open the attach flow at step 1 (FR-17).
- [ ] Step 1 lists `francois:mcp:registry` entries plus a trailing `custom…` row that remains available even if the registry call fails (FR-18, edge case).
- [ ] Step 2 generates one field per `McpRegistryParam`, masks `secret` fields, and disables submit until required fields are filled (FR-19); the `custom…` path collects name/transport/command-or-url with the same submit gating (FR-20).
- [ ] Submitting builds an `McpAttachRequest` with non-secret template substitution and `secretParams` for secret values, and calls `francois:mcp:attach` (FR-22).
- [ ] A duplicate server name is rejected client-side before submit and server-side with `INVALID_INPUT` if it slips through (FR-23).
- [ ] Successful attach closes the flow; the new server subsequently appears via `mcp.update` (FR-24).
- [ ] Failed attach (`INVALID_INPUT` or `MCP_ERROR`) keeps step 2 open with an inline error and preserved form values (FR-25).
- [ ] No IPC call in this feature ever mutates user-scope MCP config (FR-26, code review check).
- [ ] Pane [4]'s border/title reflect the app-shell focus state exactly as specified (FR-27).
- [ ] Responses for a session that is no longer active are discarded on arrival (FR-28).

## Remediation

(Empty until a review returns findings.)

# Configuration

Francois configures a session at four levels: the **account** it runs under (which Claude Code
config directory it uses), a **permission mode** picked when the session is created, a per-tool
**rules editor** that writes directly into Claude Code's own `settings.json`, and
**project-level** defaults and standards that apply to every session started under a project.
None of this is a Francois-specific settings format — with the exception of two small
Francois-owned sidecar files noted below, everything is either a Claude Code file Francois reads
and writes, or an in-app registry that only pre-fills Claude Code fields.

## Accounts

An account is a Claude Code config directory (`CLAUDE_CONFIG_DIR`). The built-in `default`
account sets no override and uses your ordinary `~/.claude`; each added account owns
`<app data>/accounts/<id>/` and is registered in `accounts.json` alongside `projects.json` and
`sessions.json`. Every `claude` process a session spawns — the turn, the usage probe, the
remote-control PTY, the SHELL tab — inherits that directory. The full flow, including what is
mirrored from your global `~/.claude` and what is deliberately not, is in
[Accounts & usage](/guide/accounts).

## Permission modes

Every session runs under one of Claude Code's own permission modes: `default`, `plan`,
`acceptEdits`, or `bypassPermissions`. Francois does not invent these modes or change their
semantics — it surfaces them as a single choice in the New Session flow (see
**Getting Started**) and, when the session belongs to a project, can pre-fill one from that
project's defaults (below). What each mode is named for and how it changes tool-call
handling in Claude Code itself is out of scope for this page; here is what determines
whether an approval card shows up in Francois:

| Mode | What Francois observes |
|---|---|
| `default` | Every gated tool call without a matching rule arrives on the control channel as a `can_use_tool` request. Francois parks it and renders an approval card in the transcript (see below). |
| `plan` | Behaves like `default` for approval purposes. A plan's `ExitPlanMode` call arrives as an ordinary `can_use_tool` request and gets an ordinary approval card — there is no plan-specific card treatment yet. |
| `acceptEdits` | Decided upstream by the Claude Code CLI itself. No `can_use_tool` request reaches Francois for the calls this mode auto-approves, so no card appears. |
| `bypassPermissions` | The permissive end of the spectrum: decided upstream by the CLI with no control-channel round trip at all, so Francois never sees a card for it. |

A session created with the **allow git** flag additionally auto-approves direct `git`/`gh`
Bash calls with no card, independent of the permission mode above — this check runs before a
call would otherwise be parked. `allow git` is set per session (or inherited from a
project's defaults, below), not a permission mode itself.

## The rules editor over Claude Code's settings.json

Francois turns every gated tool call that isn't covered by an existing rule into a live
**approval card** in the session transcript: it shows the tool name, the input, the working
directory, and four actions — **Allow once**, **Deny once**, **Always allow**, **Always
deny**. The "once" actions decide that single call and write nothing to disk. The "always"
actions write a real Claude Code permission rule into `permissions.allow` or
`permissions.deny` in a `settings.json` file, generating a pattern from the actual call (for
example `Bash(git commit:*)`, labelled "git commit (any arguments)").

Because the rule lands in Claude Code's own settings, **Claude Code enforces it upstream of
the control channel from then on** — a matching future call is decided by the CLI itself and
never reaches Francois as a card at all. The approval queue therefore only ever shows
*un-ruled* calls, and quiets down as the ruleset matures. Francois is a front end for Claude
Code's native permission system, not a second, parallel one.

### Tiers

Every rule is written to one of two tiers:

| Tier | File | Selected by |
|---|---|---|
| `local` (default) | `<session cwd>/.claude/settings.local.json` | Default — a trust decision in one repo never leaks into another. |
| `global` | `~/.claude/settings.json` (the WSL distro's home, for a WSL session) | A tier switch on the approval card, flipped before clicking Always allow/deny. |

Writes are **surgical**: the file is read, only the `permissions.allow` / `permissions.deny`
array for the target tier is touched, and every other key — `env`, `hooks`, `model`,
`mcpServers`, anything else — is preserved byte-for-byte in value. An unparseable settings
file is never overwritten; the write fails instead of silently discarding hand-edited
content. Claude Code's `permissions.ask` key is read and displayed by the rules editor
(and can be toggled, deleted, or re-tiered there) but Francois never writes an `ask` rule
itself — an ask rule is exactly what an unresolved approval card already is.

Claude Code's settings format has no notion of a "disabled" rule, so toggling a rule off in
the editor moves its pattern out of `settings.json` into a Francois-owned sidecar file next
to it, `francois-permissions.json`; toggling it back on moves it back. Francois is the only
writer of that sidecar.

### Rule effects

| Effect | Glyph in the editor | Meaning |
|---|---|---|
| `allow` | `✓` | Matching calls are approved without a card. |
| `deny` | `⊘` | Matching calls are refused without a card. |
| `ask` | `?` | Claude Code itself still asks — this is what an unresolved approval card represents; Francois never writes this effect. |

### Managing rules

The command palette's **Manage permissions** command opens a modal listing every rule
across both tiers, each with its human-readable label, its raw Claude Code pattern, a tier
chip, an enable toggle, a re-tier control, and a delete action. The list is read fresh from
disk every time the modal opens and after every change — Francois never assumes its own
cache matches what's on disk, since Claude Code or a person editing the file by hand can
change it between app launches.

What this page does **not** cover, because Francois deliberately leaves it alone: an audit
log of decisions, watching `settings.json` for external edits (the editor is read-on-open
only), hand-authoring an arbitrary glob pattern outside of a real approved call, and any
other `settings.json` key such as `permissions.defaultMode` or `additionalDirectories` —
those are read never, written never.

## Project-level configuration

A **project** is a named, persisted workspace rooted at a directory. It exists so that a
session doesn't have to be configured from scratch every time — a project remembers a set
of session defaults and a set of coding standards, and both are available from the New
Session flow once the project has been created (via the command palette's **Manage
projects** command, or the title bar's project switcher).

### The project registry

Projects are stored in `projects.json` in Francois's application data directory (alongside
`sessions.json`), one entry per project: an id, a display name, an absolute normalized
root directory, the session defaults below, and creation/last-used timestamps. Names are
not required to be unique; the root is — two projects cannot point at the same normalized
directory. A project whose root no longer exists on disk is flagged read-only except for
its name/root fields and removal; it cannot back a new session until its path is fixed.

### Session defaults

Each project can set the following fields, every one optional — an unset field means
"inherit", i.e. leave whatever Francois's own pre-feature default is:

| Default | Effect when set |
|---|---|
| `accountId` | Pre-fills which [account](/guide/accounts) new sessions run under. A default naming a removed account falls back to the globally-default account. |
| `modelId` | Pre-fills the model picker in the New Session modal. |
| `effort` | Pre-fills the effort level (must be one the chosen model advertises; otherwise falls back to the model's own default). |
| `permissionMode` | Pre-fills the permission mode described above. |
| `runtime` | Pre-fills the runtime (native or WSL). |
| `allowGit` | Pre-fills the allow-git flag described above. |

These are a **snapshot at creation**, not a live link: picking a project in the New Session
modal copies its defaults onto the new session, which then owns them forever after —
editing a project's defaults later never changes a session that already exists. Any field
can still be overridden by hand before submitting; only a manual edit after that point wins
over what the project supplied. Session defaults never include permission *rules* — those
stay per-session/per-tier in the `settings.json` rules editor above; a project does not own
or override them.

### Standards written to CLAUDE.md

A project can also carry free-form **notes** and an ordered list of **rules** — short,
single-line statements like "No source file over 1000 lines" or "Tests before
implementation." Unlike the session defaults, standards are not a snapshot: Francois writes
them into the project's own `<root>/CLAUDE.md`, inside a delimited managed block

```
<!-- francois:standards:start -->
## Coding standards
...
<!-- francois:standards:end -->
```

and Claude Code re-reads `CLAUDE.md` on every turn, so an edit to a project's standards
takes effect on the very next turn of every running session in that project, with no
restart and no Francois-side signaling involved. Content outside the managed block —
anything a person wrote into `CLAUDE.md` by hand — is preserved byte-for-byte; content
*inside* the block that isn't the heading, the notes, or a rule bullet is not something
Francois's editor can represent, and is lost the next time standards are written from the
app.

Limits enforced before anything is written to disk: each rule, trimmed, must be non-empty,
at most 500 characters, and single-line; at most 200 rules; notes at most 8000 characters;
and neither notes nor a rule may contain the block's own start/end marker text (which would
otherwise let a rule silently take over the rest of the file). Clearing every rule and note
removes the block entirely rather than leaving an empty one behind, and if the file never
had a block, clearing is a no-op. A `CLAUDE.md` with a malformed marker pair (an
unterminated start, or more than one) is left untouched and the write is refused, rather
than guessing at how to repair it.

### What a project does not configure

Removing a project deletes its registry entry and un-links its sessions (which keep
running, now unlinked) but never touches anything under its root, including `CLAUDE.md`.
A project also does not own MCP server configuration or skills — those are still read
per-session from `<cwd>/.mcp.json` and `<cwd>/.claude/{skills,commands}` exactly as they are
for a session with no project at all. A per-project roster of named agents (a "fleet") is
tracked as a separate, later feature and isn't part of project configuration today.

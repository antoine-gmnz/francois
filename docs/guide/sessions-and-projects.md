# Sessions & projects

Francois orchestrates any number of Claude Code sessions in one window. This page covers the
two core entities that make that possible: the **session** (a running conversation with
Claude Code) and the **project** (a named, persisted workspace that pre-fills sessions and
carries its own coding standards).

## What a session is

A session is one Claude Code conversation, owned end to end by the Rust core: a working
directory, a model, a running/idle/done/error status, and the transcript of everything said
so far. The core spawns and supervises the underlying Claude Code process — either a new
`claude -p --output-format stream-json` child per turn (passing `--resume <id>` to keep
continuity across turns), or, if that path proves insufficient, a persistent query through a
bundled Agent SDK sidecar. Either way, every other feature in the app — the sessions list, the
conversation view, the diff view, the agents panel, the MCP panel — is a client of this
engine: they read the session's metadata and event stream and never talk to the Claude Code
process directly.

A session's status is one of four values:

| Status | Meaning |
|---|---|
| `running` | A turn (or a context compaction) is currently in flight. |
| `idle` | The session is ready and waiting for the next message. |
| `done` | The session ended cleanly on its own initiative and will not run further turns, but was not removed. |
| `error` | Spawn, stream, or process failure; an error message is attached. |

Sending a message while a session is `running` doesn't start a second turn — it queues the
text (up to 20 pending messages) and runs it as soon as the current turn finishes, with no
observable `idle` blip in between. Interrupting a running turn closes out whatever was
in-flight and, if anything is queued, immediately starts the next queued turn.

Each session also tracks context usage — tokens used against the model's context window —
updated once per completed turn, and can be compacted on demand to reduce that figure.

## The sessions sidebar

The sidebar (pane `[1]`) is the always-visible list of every session Francois is running. It
also doubles as a **fleet board**: each row is a status card showing the session's status dot,
name, abbreviated working directory, model, context usage, and — when relevant — an
uncommitted-diff file count and a running-subagent count. It hydrates once from the session
list and then stays live from the shared session event stream, so every card updates in place
as turns run, agents dispatch, and files change, with no re-fetch. See the fleet board's own
page for the full status-board detail — this page only covers what's needed to understand
sessions and projects.

Each row shows, top to bottom: a small status dot (colored and, for `running`, gently
pulsing), the session's name, its working directory (abbreviated to `~` when it's under the
home directory), and a status line reading `<status> · <model label>`. The row for the
currently active session is visually highlighted; selecting a different row (by click, or by
arrow keys + Enter) switches which session drives the rest of the window — the conversation
tab, the diff tab, the agents panel, and the MCP panel all follow the active session.

The list supports an inline `/` filter over name and path, and a right-click "Remove session"
action with an inline confirm.

## Creating a new session

Pressing `n` (or clicking "+ new session" in the sidebar footer) opens the new-session modal.
Its fields, in order:

1. **Project** — pick a configured project to inherit its working directory and defaults, or
   `— none —` for a from-scratch session (see [What a project is](#what-a-project-is) below).
   Hidden entirely if no projects are configured yet.
2. **Directory** — only shown when no project is selected; opens the native OS folder picker.
   When a project is selected this row is replaced by a read-only `runs in <root>` line, since
   the project's root *is* the working directory.
3. **Name** — defaults to the directory's basename; stays in sync with the directory until the
   user edits it by hand.
4. **Model** — one of the model catalog entries (Sonnet, Opus, Haiku), defaulting to the first
   entry unless a project default overrides it.
5. **Effort** and **permission mode** — additional per-session settings, also pre-filled from
   a project's defaults when one is selected.
6. **Runtime** — native, or **WSL** (Windows only): a WSL session runs `claude`, git, and its
   shell inside your default WSL distro rather than on Windows. See
   [Diff & shell → WSL support](/guide/diff-and-shell#wsl-support) for how paths, git, and the
   shell behave.
7. **Allow git** — auto-approves direct `git`/`gh` commands without a permission prompt, on top
   of whatever permission mode is selected.
8. **Isolate in worktree** — appears only when the chosen directory is a git repo; gives the
   session its own checkout on its own branch. See
   [Worktree isolation](/guide/worktree-isolation).

Any field pre-filled by a project can still be overridden before submitting — an override
only affects that one session and never changes the project's own defaults. Submitting spawns
the underlying Claude Code process; if the spawn fails (binary not found, not authenticated),
the modal stays open with an inline error and preserves everything the user entered so they
can fix it and retry.

## What a project is

A project is a registry entry, not a running process — think of it as a saved shortcut plus a
set of house rules for one repository. Concretely, a project is:

- a **name** and an absolute **working-directory root**, unique per project (two projects
  can't point at the same directory);
- a set of **session defaults** — model, effort, permission mode, runtime, and whether git
  operations are allowed — that pre-fill the new-session modal whenever that project is
  selected;
- a set of **coding standards** that Francois writes into that project's own
  `<root>/CLAUDE.md`, inside a delimited managed block it owns exclusively (everything outside
  the block is left untouched, byte for byte).

Projects are persisted in Francois's own app-data directory (`projects.json`), separate from
the standards themselves, which live in the repo's `CLAUDE.md` where a plain `claude` run (or
a teammate cloning the repo) picks them up natively — no Francois-specific machinery required.
`claude` re-reads `CLAUDE.md` on every turn, so editing a project's standards while a session
is mid-conversation takes effect on that session's very next turn with nothing else to do on
Francois's part.

Session defaults, by contrast, are a **snapshot at creation time**: choosing a project in the
new-session modal copies its current defaults onto the new session, and from that point on the
session owns them independently. Changing a project's defaults later never reaches back and
changes an already-created session.

A project management modal (opened from the command palette) is where projects are created,
edited, and removed, and where the standards editor lives. Removing a project deletes the
registry entry and unlinks any sessions that pointed at it — the sessions themselves keep
running, and nothing under the project's root, including `CLAUDE.md`, is touched.

Sessions don't have to belong to a project. A session created with `— none —` behaves exactly
as sessions did before projects existed: a plain directory, model, and settings with no
inherited defaults and no linked standards file.

## Durable sessions: surviving quit and reopen

Sessions in Francois are durable across app restarts, not just for the lifetime of one window.
Concretely, when the app quits and is reopened:

- **The full transcript is back.** Every finalized message, assistant reply, and tool call
  from before the restart is rendered in the conversation view exactly as it would be for a
  session that never closed — nothing is replayed as new activity, it's just there.
- **Status and context usage are restored.** A reloaded session comes back `idle` (never mid-turn
  — nothing auto-resumes on startup), with its last-known context-usage figures intact, so
  the sidebar looks correct on relaunch even before anything runs.
- **The Claude thread itself resumes**, not just the local display. The core persists the
  underlying Claude session id alongside the transcript, so the first message sent after a
  restart passes `--resume <id>` and continues the actual conversation thread on Claude's
  side, not just a locally-replayed copy of it.

If that resume fails — for example, because Claude has since pruned or expired the old thread
— Francois doesn't surface an error and stop. It transparently re-runs the same message on a
fresh thread, captures and persists the new thread id, and shows a small dismissible banner in
the conversation view: "previous thread unavailable — continuing fresh." The prior transcript
stays exactly as it was; only the underlying thread identity changed, and the user's message
still completes normally without any action on their part. The banner clears when dismissed or
when the next message is sent.

A couple of edge cases worth knowing: if the app is killed mid-turn, only the turns that had
already finished are persisted — the interrupted, incomplete turn is simply absent on reload,
and the session comes back idle so the user can just resend. And if a project a session was
linked to has since been removed, the session reloads unlinked rather than erroring.

# Conversation & permissions

The SESSION tab is where you actually work with a session: the transcript of everything Claude Code
has said and done, a composer for sending new messages, and a handful of inline cards that let you
run commands, answer questions, and approve tool calls without leaving the conversation.

## The transcript

The transcript is an ordered list of typed blocks, hydrated from the session's event buffer on open
and then kept live as new events arrive. Four kinds form the core of it:

- **User blocks** ("YOU") — what you sent, with a `queued` chip while the message is waiting to be
  acknowledged by the engine (it clears once the corresponding event arrives).
- **Assistant blocks** — Claude's text, streamed in place: each chunk appends to the block's text,
  and a blinking cursor sits at the end of the text while it's still arriving. The cursor disappears
  the instant the block finishes.
- **Tool blocks** — a one-line summary for each tool call (`Read`, `Edit`, `Grep`, …), rendered with
  a glyph and the call's summary; a trailing `· <meta>` suffix appears once the tool call completes.
- **Subagent blocks** — a dispatch line (`⇉ Dispatched subagent  <name>`) for any `Task` tool call,
  with its own completion suffix once the subagent finishes.

Blocks never change position once inserted, and replaying the same underlying event twice never
duplicates or corrupts a block — that idempotence is what lets the transcript survive a tab switch
or an app remount without gaps or repeated text.

The transcript stays pinned to the bottom while new content arrives. Scrolling up to read history
unpins it and shows a "jump to latest" pill; clicking the pill, or sending a new message, re-pins and
scrolls back down. The composer below the transcript accepts multi-line input (`Shift+Enter` for a
newline, `Enter` to send), lets you send while the assistant is still running (the message queues),
and disables itself with an explanatory hint once the session has ended or errored.

## The slash menu

Typing `/` in the composer opens an autocomplete popup listing every command the session can
actually run. It narrows as you type (the same fuzzy match used by the command palette), and you
navigate it with `↑`/`↓`, run the highlighted entry with `Enter`, or complete it (leaving a trailing
space for arguments) with `Tab`. `Esc`, or a click outside the popup, dismisses it until you edit the
slash token again.

The list behind the popup is a merged, deduplicated **per-session command registry** built from
three sources, in this precedence order:

1. **Built-ins** Francois itself intercepts (`/usage`, `/cost`, `/model`, `/status`, `/help`).
2. **Skills and commands** discovered on disk for the session's project.
3. **The CLI's own commands** — whatever `slash_commands` Claude Code reports in its `init` event
   (plugin commands, `/compact`, `/clear`, and so on), which only becomes available after the
   session's first turn.

Running a command from the menu sends exactly the text you'd have typed by hand — the menu is purely
a discovery aid, never a different code path. Anything not in the intercepted set, including custom
skills like `/spec`, still passes straight through to Claude Code as an ordinary turn.

## Answering questions from Claude

Claude Code can ask a structured, multiple-choice question mid-turn via its `AskUserQuestion` tool.
When it does, the turn **parks** — it stays `running` (the spinner and elapsed timer keep going,
because the turn genuinely is still in flight) — and a question card appears inline in the
transcript instead of streamed text.

The card renders one section per question: a header chip, the question text, and its options (label
+ description). Options are single-select or checkbox-style multi-select depending on the question,
and every section has an `other…` row for a free-text answer. The card submits automatically the
moment every section has an answer — for a single single-select question, that's the first click.

While a question is pending, the composer stays usable: a typed message queues and is sent only once
the card is answered, and its placeholder changes to remind you a question is waiting. Interrupting
the session instead cancels the pending question, leaving the card dimmed with a `— cancelled` note;
the same happens if the turn dies (crash, app quit) with a question still parked. Switching tabs and
back preserves whatever state the card was last in — pending, answered, or cancelled.

## Approving tool calls

Every gated tool call Claude wants to make — `Bash`, `Edit`, anything not covered by the session's
permission mode — arrives over the same mechanism as a question and parks the turn the same way.
Instead of a blanket deny, it renders a **permission card**: a `PERMISSION` header with the tool
name, a one-line summary of the call (the command, the file path, the URL — whatever's most
relevant to that tool), the full input as a monospace JSON block, and the session's working
directory.

Four actions sit on the card:

| action | effect |
|---|---|
| Allow once | Approves this one call; nothing is remembered. |
| Deny once | Denies this one call; Claude adapts and nothing is remembered. |
| Always allow | Approves this call **and** writes a matching rule into Claude Code's own settings. |
| Always deny | Denies this call **and** writes a matching deny rule the same way. |

A rule generated from an "always" decision is a real Claude Code permission pattern (for example
`Bash(npm test:*)`), and the card shows you exactly what it will write — the human-readable label,
the raw pattern, and which settings file it targets — before you commit to it. A tier control lets
you switch that target between **this project** (`.claude/settings.local.json`, the default, so a
trust decision in one repo never leaks into another) and **all projects**
(`~/.claude/settings.json`). Because the rule lands in Claude Code's own settings, matching calls are
decided by Claude itself from then on and never produce another card — the approval queue only ever
shows calls that aren't covered by an existing rule yet.

As with question cards, the composer stays usable and queues typed messages while a permission card
is pending, and an interrupted or dead turn cancels the card rather than leaving it stuck.

A rules editor, opened from the command palette (**Manage permissions**), lists every rule you've
accumulated across both tiers and lets you toggle, delete, or move each one between project and
global scope. The full mechanics of that editor and of Claude Code's `settings.json` — how rules are
merged in surgically, how a disabled rule is represented, tier resolution details — are documented on
the [Configuration reference](/reference/configuration) rather than repeated here.

## Interactive commands

A handful of Claude Code's built-in slash commands render as their own card in the transcript rather
than as streamed assistant text, so they never just vanish:

- **`/usage` and `/cost`** run as a background lookup that doesn't touch the session's status at all
  — even mid-turn. A loading card (`▦ USAGE`, pulsing) appears immediately and fills in place, a
  moment later, with plan-limit meters and reset times.
- **`/context`** runs as a normal turn and renders a context card once it completes: a used/limit
  meter plus the full breakdown.
- **`/model`**, **`/status`**, and **`/help`** answer instantly with no process spawned at all: a
  clickable model-catalog card (clicking a row switches the session's model), a snapshot of the
  session's current state, or a list of the commands Francois handles.
- Anything Claude Code itself answers locally that doesn't fit a richer card — an unknown command, or
  one that says it isn't available in this environment — renders as a plain dim notice line instead
  of disappearing silently.

Every one of these follows the same loading-card-to-result-card pattern: a pending block appears the
moment the command is recognized, and it's replaced in place once the answer arrives — never left
hanging, and never surfaced as a session-level error just because a background lookup failed.

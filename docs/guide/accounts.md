# Accounts & usage

Francois can run several Anthropic accounts side by side — a personal one and a work one, say —
and bind each session to whichever you pick. Every `claude` process a session spawns then runs
under that account: the turn itself, the `/usage` probe, the remote-control PTY, and the SHELL
tab's environment.

## What an account is

An account is a **Claude Code config directory** — the thing `CLAUDE_CONFIG_DIR` points at.
There is always a built-in **`default`** account, which sets no override and behaves exactly as
Francois did before this existed: it uses your ordinary `~/.claude`. Every account you add gets
its own directory under Francois's app data (`accounts/<id>/`), which is what keeps the
credentials apart.

Exactly one account is marked the default for new sessions. It's `default` until you say
otherwise.

## Adding one

Run **Add account** from the command palette (or the `+` in the Accounts modal). Francois creates
the config directory and opens a real `claude` login TUI in an embedded terminal — the actual CLI,
rendered verbatim in xterm.js with your keystrokes forwarded straight through, so it's the login
flow you already know, without the trip to a terminal.

Francois watches the new config directory for an authenticated identity and closes the terminal
the moment one lands, labelling the account with the email it captured (rename it later; labels
don't have to be unique). Three things it refuses to do quietly:

- **A duplicate identity fails loudly.** If the captured email matches an account you've already
  registered, the login is rejected and the directory deleted — some platforms share a credential
  store, and in that case the accounts genuinely cannot be isolated. Francois says so rather than
  silently billing the wrong one.
- A login that neither succeeds nor is cancelled within five minutes fails and cleans up after
  itself, as does cancelling or quitting the app mid-login.
- Only one login runs at a time.

If an account's credentials later disappear, the row isn't dropped — it's reported as
unauthenticated, with a **Re-login** action that reuses the same row and directory.

## What an account shares, and what it doesn't

`CLAUDE_CONFIG_DIR` **replaces** the user config root rather than layering onto it, so a fresh
account would otherwise start with none of the slash commands, subagents, skills or hooks you
installed globally. Francois mirrors the shared, non-credential parts of your global `~/.claude`
into each account directory — `commands`, `agents`, `skills`, `templates`, `pipeline`,
`workflows`, `hooks`, `plugins`, and `settings.json` — by symlink (a directory junction on
Windows; `settings.json`, being a file, is copied). A globally-installed skill therefore stays
live for every account, and the mirror is re-applied on every load as a backfill.

It never overwrites something the account already owns, so an account's own `settings.json`
survives. And it is one-directional and allowlisted: per-account state — `sessions/`, `projects/`,
`.claude.json`, `history.jsonl`, `cache/` — is never mirrored back.

The short version: **multi-account isolates credentials, not your toolbox.**

## Binding a session

Pick the account in the New Session modal. A project can pre-fill one through its session defaults
(see [Configuration](/reference/configuration#session-defaults)), snapshot-style like every other
default.

A session's account is fixed at creation and never changes afterwards. That's deliberate: the
resume anchor for a durable session belongs to the old account's history, so switching would
strand the thread. Make a new session instead.

Two exceptions, both automatic: removing an account repoints its sessions to `default` (and
recursively deletes its config directory), and a session that loads with an `accountId` matching
no registered account falls back to `default` rather than erroring.

## Managing accounts

The palette's **Accounts** command opens the modal: every account with its label, email and
organization, which one is the default for new sessions, rename, remove, and re-login for an
unauthenticated row. The built-in `default` account cannot be removed.

## Usage per account

Plan limits are an account-level fact, so the app row's meters track the account the *selected
session* runs on — switching between two sessions on the same account changes nothing, switching
to a session on another account swaps the figures. Each account is probed and cached separately, a
failed probe for one never disturbs another, and the meters' tooltip names the account the figures
belong to. The account chip beside the meters shows the same thing, which is the quick answer to
"which account is this session actually burning?"

The mechanics of the meters themselves — refresh cadence, the reset countdown, error degradation —
are in [Command palette → The usage bar](/guide/command-palette#the-usage-bar).

## Windows and WSL

One Windows-side config directory serves both runtimes: the account's `CLAUDE_CONFIG_DIR` is
passed into the distro through `WSLENV`, which translates the Windows path on the way in. A WSL
session therefore uses the same account directory as a native one — you log in once per account,
not once per distro.

# Remote control

Remote control lets you pick up a running Claude Code session on your phone,
tablet, or any browser at `claude.ai/code` — continuing the exact same
conversation thread, not a new one. Francois does this by **hosting** Claude
Code's own native Remote Control feature for a session; it does not build its
own remote protocol.

## What it does

When you turn remote control on for a session, Francois spawns an interactive
`claude --remote-control` process for that session in a PTY that the core
owns. That process registers a remote session with Anthropic and Francois
learns the resulting `claude.ai/code` URL, which it then shows you.

Because Francois already persists each session's `claudeSessionId`
(durable sessions), the remote-control host resumes that same id instead of
starting a fresh thread. Anything already in the transcript is what shows up
when you open the URL on another device, and anything you or Claude add from
either side continues the same conversation.

Francois is the **host** side of remote control only. It cannot act as a
remote-control *client* — there is no local protocol to drive someone else's
session; the relay is outbound HTTPS to Anthropic with short-lived
credentials, and only Anthropic's own web and mobile clients can drive a
remote session. So this feature is strictly "reach a Francois session from
your phone," never the reverse.

## Starting it per session

Remote control is a toggle scoped to a single session, not a global setting.
Turning it on for a session:

- Reuses that session's existing Claude thread with `--resume` if it already
  has a `claudeSessionId`, or mints a fresh one and passes `--session-id` so
  the transcript path is known before the child process says anything.
- Uses the session's name for the remote-control label, unless you gave the
  toggle a different name.
- Is idempotent: toggling on a session that's already starting or active just
  returns its current status — the Claude CLI only allows one remote session
  per process, so Francois never spawns a second host for the same session.
  A session whose host previously failed gets a fresh one on retry.

Turning it off kills the host process and clears its state. Quitting
Francois does the same for every remote-controlled session in the window —
no host is left running (and no remote session left live on your account)
after the app closes.

Starting a host can fail. The most common case is a session folder with an
unapproved `.mcp.json` server, or an unapproved "trust this folder" prompt:
the underlying `claude` process stops on that consent dialog and waits for a
keypress Francois will never send (these are your trust decisions, so
Francois never auto-answers them). When that happens the session's remote
control state goes to failed within seconds, with a message telling you to
run `claude` in that folder once, approve the prompt yourself, and retry —
rather than leaving you to wait out a timeout. Remote control also requires
a claude.ai Pro/Max/Team/Enterprise login; API-key or Bedrock/Vertex/Foundry
setups are rejected by the CLI and likewise surface as failed.

## The URL and copying it

Once the host registers, Francois surfaces a `https://claude.ai/code/session_…`
URL for that session. Opening it in a browser, or on the Claude mobile app,
continues the same thread the session already had. A short `session_…`
handle is also shown alongside it.

The URL is copyable from the UI (see below) so you can send it to your phone
without typing it. A QR code for scanning is a deferred piece of this
feature — for now, copying the link and opening it on the other device
covers the same case in one extra step.

## What keeps working, and the status badge

Remote control doesn't change what a session can do locally: the transcript,
the diff view, and the shell tab keep working in Francois exactly as before.
Remote control just adds another live entry point into the same Claude
thread — anything typed on the phone lands in the same conversation you see
in Francois, and vice versa.

In the UI, a small `rc` chip sits in the SESSION tab's header meta row, with
a status dot:

- **off / idle** — no host running for this session (disabled tone).
- **starting** — the host is registering; counts as "live" so the toggle
  flips immediately, but there's no URL yet.
- **active** — a URL has been published. The chip discloses a popover with
  the full URL, a copy action, and a stop control.
- **failed** — the host didn't reach active; the chip shows the reason (for
  example, the consent-dialog message above).

A remote session only survives as long as its host process does — nothing
about remote control is persisted across a Francois restart. If Francois
restarts, every session's remote control state comes back as off, and you'd
start a new host to reach it remotely again.

# Notifications & sound

Francois tells you about exactly two things, because they're the two moments a fleet actually
demands your attention:

| Class | Fires when |
| --- | --- |
| **attention** | A session is blocked on you — a permission approval, or an `AskUserQuestion` card. |
| **turn-done** | A session's turn settled — it finished, or it errored. |

Both classes have two sinks: a **desktop banner** and a **tone**. They read the same trigger stream,
so a banner and a tone never disagree about what happened; they differ only in when they're allowed
to fire.

## Desktop banners

A banner is an ordinary OS notification, delivered through the platform's own notification centre.
Clicking one focuses Francois and selects the session it came from, so a banner is a way back into
the work rather than just a nudge.

Turn-done banners are **focus-gated**: if Francois is already the foreground window when the turn
lands, you were watching it, and the banner is suppressed. Attention banners are not gated the same
way — being blocked matters whether or not you're looking.

Each class can be muted independently from the command palette (**Toggle attention notifications**,
**Toggle turn-done notifications**), and a muted chip appears in the app row so a silenced app never
looks like an idle one.

## Tones

Banners only help when you're looking where banners appear. The common Francois posture — several
sessions running, Francois in the foreground, your eyes on an editor on the same screen — gets no
useful cue from a banner in a corner, and the focus gate suppresses the turn-done one exactly then.

So the same two classes also play a **short synthesized tone**:

- **No focus gate.** The tone plays whether or not Francois is in front — that's the whole point.
- **Synthesized, not sampled.** Web Audio oscillators, no asset file, nothing to download or ship.
  Two tones only, one per class.
- **One master toggle** — `⌘K` → **Toggle sound**. There is no per-class sound switch; the banner
  toggles above already give you per-class control.
- **Throttled** to at most one tone every 1.5 seconds, so four sessions settling together give you
  one cue rather than a chord.
- **Silent under Do Not Disturb.** Francois probes the OS's own DND / Focus / Quiet Hours state and
  drops the tone while it's on. The probe is permissive by design: on a platform where it can't
  read the state, or if the read fails, the tone plays rather than being silently swallowed.

Everything about the sound path is a convenience cue — it can suppress a tone, never gate anything
that matters. If audio is unavailable entirely (no output device, a webview that refuses to start an
audio context), the banners carry on unaffected.

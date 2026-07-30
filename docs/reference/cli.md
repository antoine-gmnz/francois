# The francois CLI

Installing via `npm i -g francois` also puts a small `francois` launcher on your `PATH`. This is
the install/launch companion — it is **not** a live control channel into an already-running app
(a "talk to the running app" CLI companion is a planned, not-yet-built feature; see
[What is Francois?](/guide/what-is-francois#what-s-next)).

## Commands

| Command | Effect |
| --- | --- |
| `francois` | Launch the app and return to the shell. |
| `francois --attach` | Launch it in the foreground with its output attached. |
| `francois --version` | Print the app and package versions. |
| `francois shortcut` | Re-register the desktop entry — useful after deleting it by hand, or after a headless install. |
| `francois shortcut --remove` | Unregister just the desktop entry, without touching the npm package. |
| `francois uninstall` | Unregister the desktop entry, then remove the npm package. This is the supported way to uninstall. |
| `francois --help` | Usage. |

## Why `francois uninstall` and not `npm uninstall -g francois`

Current npm (v7+) doesn't run a package's `preuninstall` hook on a plain
`npm uninstall -g francois` — so that alone leaves the installed app behind (in
`~/Applications` on macOS, or the Start Menu / `.desktop` entry elsewhere). `francois uninstall`
runs the desktop de-registration itself before removing the package, so nothing is left behind.

## Environment variables

| Variable | Effect |
| --- | --- |
| `FRANCOIS_SKIP_DOWNLOAD=1` | Skips the postinstall's binary download — useful for CI or a scripted install where the binary is provided another way. |
| `FRANCOIS_DOWNLOAD_BASE` | Overrides the release host the postinstall downloads from — for mirrors or air-gapped setups. |

## What actually gets installed

See [Getting started](/guide/getting-started#install) for the full per-platform breakdown of
what `npm i -g francois` registers with your desktop, and why it launches without a SmartScreen
or Gatekeeper warning.

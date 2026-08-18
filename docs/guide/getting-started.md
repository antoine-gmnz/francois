# Getting started

## Install

```sh
npm i -g francois
```

Then open Francois from the **Start Menu, Launchpad, or your applications menu** like any other
app — or type `francois` in a terminal, whichever you prefer.

This is a real install, not just a command on your `PATH`: the package's postinstall downloads
the matching platform build from the project's [GitHub releases](https://github.com/antoine-gmnz/francois/releases),
verifies it against a published sha256 digest, and registers it with your desktop.

| Platform | What gets registered |
| --- | --- |
| Windows | a Start Menu shortcut, and an entry in Settings → Installed apps |
| macOS | the app in `~/Applications` — found by Spotlight, Launchpad, and the Dock |
| Linux | a `.desktop` launcher and icon under `~/.local/share` |

Everything is **per-user** — no administrator rights, no elevation prompt. `npm uninstall -g francois`
does **not** fully clean up (current npm doesn't run the `preuninstall` hook that would need);
run `francois uninstall` instead. See [The francois CLI](/reference/cli) for the full command
reference.

### Why no security warnings

Windows SmartScreen and macOS Gatekeeper key off the Mark-of-the-Web / `com.apple.quarantine`
attribute that a **browser** attaches at download time. A binary fetched by npm's postinstall
never carries one — so the same unsigned build that would get blocked as a browser-downloaded
`.exe` or `.dmg` launches clean here. No certificate, no *More info → Run anyway*, no
right-click → *Open*.

Every push to the project's `main` branch cuts a new version, so `npm i -g francois` always gets
you the newest build; `npm update -g francois` moves an existing install forward.

### Or use the native installers

Prebuilt installers are attached to every [GitHub release](https://github.com/antoine-gmnz/francois/releases/latest):
Windows (`.exe`/`.msi`), macOS universal (`.dmg`, Apple Silicon + Intel), Linux (`.AppImage`/`.deb`).
These are **unsigned** — the browser download marks them, so on Windows you'll need
*More info → Run anyway* in the SmartScreen prompt, and on macOS, right-click the app →
*Open* (or `xattr -cr /Applications/Francois.app`).

## Requirements

- **Node 18+** — you already have it if Claude Code runs.
- **[Claude Code](https://claude.com/claude-code)**, installed and authenticated — `claude` must
  be on your `PATH`. Francois spawns it per session.
- **`git`** on your `PATH` — powers the DIFF tab.
- **Windows only**: the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (already installed on Windows 11 and current Windows 10).
- **Using WSL?** A session created with the WSL runtime runs `claude` and git *inside* your
  **default** WSL distro — so both must be installed and authenticated there too, not just on
  Windows. See [Diff & shell → WSL support](/guide/diff-and-shell#wsl-support).

## Build from source

```sh
# prerequisites: Node 20+, Rust stable, and the Tauri 2 platform dependencies
npm ci
npm run dev:app        # run it (dev identity — safe next to an installed Francois)
npm run build:app      # produce installers (stable identity: Francois)
npm run build:app:dev  # produce installers (dev identity: Francois Dev)
```

The dev and stable builds are **separate apps** (`com.francois.dev` vs. `com.francois.desktop`)
with separate data directories, so you can run both at once without sessions colliding — handy
if you're testing a change while the installed version keeps running your real sessions.

## Your first session

1. Open Francois. If you haven't added a [project](/guide/sessions-and-projects#what-a-project-is) yet,
   you'll be prompted to pick one — a working directory Francois remembers, with its own session
   defaults.
2. Press `n` (or the **+ new session** action in the roster) to open the **New Session** modal.
3. Pick the project, name the session, choose a model and effort level, and a permission mode.
   Leave the **worktree** options alone for now — that's covered separately in
   [Worktree isolation](/guide/worktree-isolation), as is the optional
   [profile](/guide/sessions-and-projects#session-profiles). If you've registered more than one
   [account](/guide/accounts), pick which one this session runs under while you're here — it's
   fixed once the session exists.
4. **Create session** — the SESSION tab opens with an empty transcript and a composer at the
   bottom. Type a prompt and go.

From here, `1` and `2` move focus between the roster and the main pane, `3`–`6` open the agents,
MCP, skills and workflows views, `⌘K`/`Ctrl+K` opens the command palette for everything else, and
the [Interface tour](/guide/interface-tour) walks through what every part of the window does.

## Staying up to date

Every push to `main` cuts a release, and Francois checks for one itself: when a newer version is
available an **update chip** appears in the app row, and `⌘K` → **Check for updates** probes on
demand. Installing from the chip replaces the app in place. `npm update -g francois` does the same
thing from a terminal.

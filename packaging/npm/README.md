# francois

**Mission control for your Claude Code fleet** — installed without an installer.

```sh
npm i -g francois   # stable
francois            # launch it
```

```sh
npm i -g francois@dev   # rolling build of main
```

This package ships no binaries. Its postinstall downloads the platform build from
the matching [GitHub release](https://github.com/antoine-gmnz/francois/releases)
and verifies it against a sha256 digest baked in at publish time.

## Why install this way

Windows SmartScreen and macOS Gatekeeper key off the Mark-of-the-Web /
`com.apple.quarantine` attribute that a **browser** attaches at download time.
Binaries fetched by a CLI never carry one — so the same unsigned build that gets
blocked when downloaded as a `.dmg` or `.exe` launches clean from here. No
certificate, no *More info → Run anyway*, no right-click → Open.

## Requirements

- Node 18+
- [Claude Code](https://claude.com/claude-code) on your `PATH`, authenticated — Francois spawns `claude` per session
- `git` on your `PATH` — powers the DIFF tab
- Windows only: the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11 and current Windows 10)

Prebuilt for macOS (universal), Windows x64 and Linux x64. On anything else,
[build from source](https://github.com/antoine-gmnz/francois#build-from-source).

## Usage

| Command | Effect |
|---|---|
| `francois` | launch the app and return to the shell |
| `francois --attach` | launch it in the foreground with its output attached |
| `francois --version` | print the app + package versions |
| `francois --help` | usage |

Environment: `FRANCOIS_SKIP_DOWNLOAD=1` skips the postinstall download,
`FRANCOIS_DOWNLOAD_BASE` overrides the release host (mirrors, air-gapped setups).

[Full documentation](https://github.com/antoine-gmnz/francois) ·
[AGPL-3.0](https://github.com/antoine-gmnz/francois/blob/main/LICENSE)

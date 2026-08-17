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
| `francois ext …` | Manage extensions on disk — see below. |

## Managing extensions

These three verbs operate **directly on `~/.francois/extensions/`**: no socket, no running app
required, and they never enable anything. Enabling is the app's job, behind the consent dialog —
see the [Extensions guide](/guide/extensions).

| Command | Effect |
| --- | --- |
| `francois ext install <name\|path\|git-url>` | Copy a local directory, or clone a git URL, into `~/.francois/extensions/<id>/`. Validates the manifest before writing. Installs **disabled**. |
| `francois ext install … --force` | Overwrite an existing install. This is also how you update one. |
| `francois ext list` | List every installed extension: id, label, path, and `enabled` / `disabled` / `invalid manifest`. |
| `francois ext remove <id>` | Delete an installed extension and its consent record. Asks for confirmation. |
| `francois ext remove <id> --yes` | Skip the confirmation. |
| `francois ext --help` | Usage. |

The install source can be four things, resolved most-explicit-first:

| You type | Francois uses |
| --- | --- |
| `./my-plugin` | that directory, copied |
| `https://…` or `git@host:path` | that repository, cloned shallow |
| `thing` | `github.com/antoine-gmnz/francois-plugin-thing` |
| `someone/thing` | `github.com/someone/francois-plugin-thing` |

An **existing local directory always wins** over the bare-name form, so a bare name never silently
reaches the network when a local answer exists. The bare-name form is a naming convention resolved
by string substitution — there is no registry index, nothing to search, and no version resolution.

The extension's **id is the directory name** it lands under (with any `francois-plugin-` prefix
stripped), never a field the manifest declares. It must match `^[a-z][a-z0-9-]{0,31}$`.

::: warning Updating flips it back off
Consent is bound to the manifest's sha256. Reinstalling with `--force` — or editing the manifest by
hand — reverts the extension to **disabled**, and you re-enable it in the app after reviewing the
new commands.
:::

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

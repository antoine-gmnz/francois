# Extensions

Francois shows you sessions, diffs and agents. It does **not** know about your container runtime,
your task queue, your build cache, or whatever else you keep alt-tabbing to. Extensions close that
gap: a small manifest on disk tells Francois **which command to run** and **how to display its
output**, and you get a new main-pane tab beside SESSION / DIFF / SHELL.

An extension is a directory with one file — `extension.json`. It contains **no code**. It cannot
ship a binary, cannot contribute JavaScript or CSS, and cannot name an absolute path. It declares
commands, and Francois runs them out-of-process under fixed limits. That constraint is the whole
security model, and it is what lets the consent dialog show you the truth in five lines instead of
asking you to audit a program.

## Installing one

Extensions live in **`~/.francois/extensions/`**, and nowhere else — never in a repo, never in a
`package.json` key, never in `<project>/.francois/`. A repository you clone cannot introduce an
extension.

```sh
francois ext install ./my-plugin                    # a local directory
francois ext install cohorte                        # → github.com/antoine-gmnz/francois-plugin-cohorte
francois ext install someone/thing                  # → github.com/someone/francois-plugin-thing
francois ext install git@github.com:you/repo.git    # any git URL
```

The bare-name form is a **naming convention**, not a registry — there is no index, nothing to
search, and nobody curating a list. It is string substitution, and a local directory of the same
name always wins over the remote.

The extension's **id is its directory name** (`my-plugin`), never something the manifest declares —
so nothing can impersonate an id you already trust.

To try the bundled example:

```sh
francois ext install ./examples/extensions/plugin-example
```

::: tip These verbs never touch the app
`ext install`, `ext list` and `ext remove` work directly on the filesystem. They work with Francois
closed, and they never enable anything.
:::

## Enabling one — installing is not authorizing

A freshly installed extension arrives **disabled** and runs nothing at all — not even its own
detection probe. To turn it on:

1. Open **Extensions** — the icon in the title bar next to the project selector, or **⌘K →
   `Extensions`**.
2. Find its row. Every installed extension is listed, including ones this project doesn't match and
   ones whose manifest is broken. **A row is never hidden.**
3. Click **Review & enable**.

A dialog appears titled *"`<id>` wants to run these commands"* and lists **every distinct command
the manifest declares**, verbatim, one per line, never truncated — a hidden flag is precisely what
this dialog exists to prevent. Below them, the directory the manifest was read from.

**Cancel** holds the focus, not Enable. Hitting return by reflex leaves the extension off.

Once granted, the row's control becomes a plain toggle you can flip freely.

## When a manifest changes

Your consent is bound to the **sha256 of the manifest bytes you read**. Edit the file, pull an
update, reinstall over it — the consent no longer matches, and the extension **reverts to
disabled**. Its row shows *"changed since you enabled it"* and offers **Review again**, which shows
the new commands.

This is also why there is no `ext update` command. To update, reinstall over it:

```sh
francois ext install <same source> --force
```

For a git source the new clone is fetched and validated in a scratch directory first, so a broken
update never destroys a working install. Then re-enable it in the app — deliberately, having read
what changed.

## Using an extension's tab

An enabled extension whose detection predicate matches the current project gets a **tab after SHELL**
in the main pane. Click it to open, click its `×` to close. Extension tabs carry no status dot: an
extension has no lifecycle for the chrome to report.

Inside, each panel is one of four shapes:

| | |
|---|---|
| **key-value** | a labelled list — status, config, versions |
| **stat-row** | tiles of headline numbers |
| **table** | rows and columns, paginated on demand |
| **log-tail** | a live stream of lines, following a row you select in a sibling table |

A table paginates with **Load more**, 100 rows at a time, and stops at 2000 with *"showing first
2000 rows"* — Francois will not let a panel grow without a ceiling. A panel may declare an
auto-refresh, floored at 2 seconds.

**Detection** decides whether a tab is offered at all, from one of three predicates: a path exists,
a JSON file has a given value at a given pointer, or a command exits 0. That last one is the only
predicate that spawns anything, so before you consent it isn't run — the row reads *"not evaluated —
enable to detect"* instead. **Re-detect** in the modal footer re-scans the directory and re-runs
every predicate for the current project.

## Listing and removing

```sh
francois ext list      # id, label, path, and enabled | disabled | invalid manifest
francois ext remove my-plugin
```

`remove` asks for confirmation (`--yes` skips it), refuses any path outside
`~/.francois/extensions/`, and drops the consent record with the directory.

## What the limits are

Every provider process Francois spawns runs under fixed, non-negotiable caps:

- **No shell, ever.** The command is a bare binary name resolved on `PATH` plus a literal argument
  array. `sh`, `bash`, `cmd`, `powershell`, `env` and absolute paths are refused when the manifest
  is loaded, not filtered when it runs.
- **Scrubbed environment**, a **10 second** timeout, **4 MiB** of output, at most **4** running at
  once, and a kill that takes the whole process group. The scrubbed `PATH` is the **login shell's**,
  not the one a GUI app inherits — so a provider whose binary lives in nvm, Homebrew, pnpm, cargo or
  `~/.local/bin` resolves the same way it does in your terminal. (Relative and empty `PATH` entries
  are dropped, so a repo can never make a bare name resolve inside itself.)
- Output is sanitized in the Rust core before it ever reaches the window — a provider cannot emit
  terminal escapes or markup that renders.
- A `log-tail` stream is capped at 2000 lines / 1 MiB and drops its oldest lines past that.

## When a panel shows an error

Panels report the cause rather than a generic failure — `docker not found on PATH`, `timed out after
10s`, `exited 128`, `output exceeded 4 MiB`, `output did not match the panel's shape`. Each offers
**Retry**, and **disable** if you'd rather it stop asking.

A broken manifest never partially loads: the whole extension is refused, and its row shows the
failure with the JSON pointer to the offending field.

## What extensions deliberately cannot do

- **Run code.** No JS, no CSS, no WASM, no bundled executable. A manifest names commands you already
  have on your `PATH`.
- **Change anything.** Panels are read-only. There are no buttons that act, no forms, no mutating
  operations — whether a manifest may ever declare one is an open question, not an oversight.
- **Live in a repository.** Only `~/.francois/extensions/`, at any scope, ever.
- **Be searched, versioned, or signed.** There is no registry index, no semver resolution, no
  dependency graph, and no signature. Consent is the entire trust story: you read the commands and
  you decide.

`"manifest": 1` is a **refusal marker**, not a stability promise — it exists so a future schema can
tell an old manifest apart from a new one. There is no compatibility guarantee across Francois
versions yet.

## Writing your own

Start from the worked example in the repo — `examples/extensions/plugin-example/`. It drives `git`
(the one binary every Francois user has), and its two panels exercise the whole schema in one file:
a detection predicate, the line-splitting output adapter, and pagination. Its
[README](https://github.com/antoine-gmnz/francois/blob/main/examples/extensions/plugin-example/README.md)
walks the manifest field by field.

The shape, in brief:

```json
{
  "manifest": 1,
  "label": "My tool",
  "detect": { "kind": "pathExists", "path": "my-tool.yml" },
  "panels": [
    {
      "id": "status",
      "label": "Status",
      "scope": "project",
      "primitive": "table",
      "emptyCopy": "nothing running",
      "columns": [{ "key": "name", "label": "Name", "kind": "text" }],
      "provider": {
        "argv0": "my-tool",
        "args": ["status", "--json"],
        "output": { "kind": "json" }
      }
    }
  ]
}
```

`output.kind: "json"` means your command prints a document already in the panel's payload shape
(`{"rows": [...]}`). If it prints plain lines instead, `"kind": "lines"` splits each one on a
separator into named fields — which is how the example drives `git` without a JSON mode.

Copy the directory into `~/.francois/extensions/`, open Extensions, review, enable. Editing the
manifest afterwards flips it back to disabled — which is the system working, not a bug.

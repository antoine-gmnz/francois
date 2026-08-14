# plugin-example — a worked `extension.json`

A **worked example**, not a built-in — the compiled registry is gone
(`specs/extension-install.md` §1). It drives `git`, because that is the one
binary every Francois user is guaranteed to have on `PATH`, and because two git
panels exercise the whole schema in one file: a detection predicate, the
`lines` output adapter, and pagination. Copy this directory into
`~/.francois/extensions/plugin-example/` to install it, review its commands in
the Extensions modal, and enable it. Then edit `extension.json` to learn the
schema field by field, below.

> It is named for what it **is** (an example plugin), not for what it drives —
> Francois already has a native DIFF tab doing git, and an extension called
> `git` would read as a duplicate of it rather than as a teaching file.

## Installing

```sh
francois ext install ./examples/extensions/plugin-example
```

This copies the directory to `~/.francois/extensions/plugin-example/` (the id is
the directory name — here, `plugin-example`) and prints that the extension
arrived **disabled**. Open Extensions (⌘K) to review its commands and enable it —
installing is never authorizing (`specs/extension-install.md` FR-15..FR-17).

## The manifest, field by field

```json
{
  "manifest": 1,
  "label": "git example"
}
```

- `manifest` — must be `1`. Any other value is refused as unsupported
  (`EXT_MANIFEST_UNSUPPORTED`); it exists so a future schema change can tell
  an old manifest apart from a new one, not as a stability promise.
- `label` — the display name. Optional; falls back to the directory name.
- `id` — do NOT set this. An extension's id is its directory name (FR-3); a
  manifest that declares a conflicting `id` is refused.

### `detect` — one predicate, from a closed set of three

```json
{ "kind": "pathExists", "path": ".git" }
```

- `pathExists` — `{ path }`: true when `<root>/<path>` exists, file or
  directory.
- `pathJsonEquals` — `{ path, pointer, equals }`: `<root>/<path>` parses as
  JSON and the RFC-6901 `pointer` resolves to the string `equals`.
- `commandSucceeds` — `{ argv }`: the process exits 0. This is the only
  predicate that spawns anything, and it never runs before the extension is
  enabled (FR-17) — an extension whose only predicate is `commandSucceeds`
  reads `not evaluated — enable to detect` until then.

### `panels` — one entry per tab section

Every panel needs `id` (a lowercase-kebab slug, unique within this manifest —
the tab's real id becomes `<dir>:<id>`, e.g. `plugin-example:branches`), `label`,
`scope` (`fleet` or `project`), `primitive` (`key-value` | `table` |
`stat-row` | `log-tail`), and `emptyCopy` (shown for a validated zero-row
result). A `table` also needs `columns`.

This example's two panels exercise the parts of the schema a plugin author
needs most:

- **`branches`** — a `table` fed by `git for-each-ref`, using the `lines`
  output adapter (below) and `pathExists` detection.
- **`log`** — the same shape, `paginated: true`, so it also exercises
  `pageArgs` and the `${offset}`/`${limit}` placeholders.

### `provider` — what a non-`log-tail` panel spawns

```json
{
  "argv0": "git",
  "args": ["log", "--format=%h%an%cI%s"],
  "pageArgs": ["--skip=${offset}", "-n", "${limit}"],
  "output": { "kind": "lines", "separator": "", "fields": [...], "idField": "commit" }
}
```

- `argv0` — a BARE binary name resolved on `PATH` at spawn time. Never an
  absolute path, never a shell (`bash`, `sh`, `cmd`, …) — both are refused at
  load time, not filtered at run time.
- `args` — a literal argv array. `${offset}`/`${limit}` are substituted by
  the core with Rust-rendered numbers; there is no shell, ever, so nothing
  here is "interpolation" in the injection sense.
- `pageArgs` — appended only for a paginated request; leave it out for an
  unpaginated panel.
- `output.kind: "json"` — the default: stdout is one JSON document already in
  the primitive's payload shape (`{ rows: [...] }`, `{ tiles: [...] }`, …).
- `output.kind: "lines"` — `table` only. Each non-empty line is split on
  `separator` into `fields`; `idField` names which field becomes the row id
  (defaulting to the first). A field literally named `tone` decides the
  row's tone (`ok` | `warn` | `error` | `neutral` | `busy`); every other
  field lands in `cells` verbatim. This example's separator is the ASCII
  unit-separator character (`U+001F`, baked into git's own `--format` string)
  so a commit subject containing a literal space or tab never misaligns the
  columns.

### `log-tail` panels (not used by this example)

A `log-tail` panel has no `provider` — instead:

```json
{
  "primitive": "log-tail",
  "tokenSource": { "panelId": "containers", "rowKey": "id" },
  "source": { "kind": "process", "argv0": "docker", "args": ["logs", "-f", "--", "${token}"] }
}
```

or, for a plain file:

```json
{ "source": { "kind": "file", "path": "logs/${token}.log" } }
```

`tokenSource` names a SIBLING `table` panel and the column its selected row
fills the `${token}` slot from. At most one panel in the whole manifest may
declare a `${token}` slot.

## Validating

`cargo test` in `src-tauri` loads and validates this exact file as a fixture
— a schema change that breaks it fails the build (FR-32).

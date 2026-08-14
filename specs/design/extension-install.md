# DESIGN BRIEF — Extension install (`extension-install`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/extension-install.md`, standalone.

**Goal:** the user sees what plugins are installed on their machine, reads the commands each one
declares, and decides — one at a time — which are allowed to run.

**Design system:** the existing UI kit (`src/ui/`) and the tokens in `src/styles.css`. Identity v2 —
acid `#c3f53f` is *the live thing*, one per view; ready-green is `#4fae86`. Reference
`Francois Redesign.dc.html` (turn 4, the current shell) and `Francois Design System v2.dc.html` for
the surfaces, type roles and geometry. **This is a desktop app** — there is no mobile breakpoint.

## Screens / views

- **Extensions modal — `Installed` section** — the whole surface of this feature. Reached from ⌘K
  (`Extensions`) and the icon beside the project switcher in the session row. `src/ui/Modal`, the
  `AccountsModal` register.
  - Elements per row: the extension **id** (mono, the primary handle — it is the directory name);
    the **label** from the manifest (sans, dimmer, secondary); the **source path** (mono, dim,
    truncated **from the left** like the `path` column kind, so `.../extensions/k8s` stays legible);
    a **detection line** (`available here` / `.git not found in acme-api` / `not evaluated — enable
    to detect`); and one **trailing control**.
  - The trailing control is the whole state machine, and only one of three things:
    - consent `granted` → the existing **toggle** (same component as today's per-extension toggle)
    - consent `never` → a **`Review & enable`** button, `src/ui/Button` secondary register
    - consent `stale` → the same button reading **`Review again`**, with the row carrying
      `changed since you enabled it` in the warn tone
  - States: **empty** (no directory / no plugins) · **loaded** · **row-level error** (invalid
    manifest) · **row-level stale**. There is no loading state worth drawing — the scan is local
    filesystem and lands within a frame.
  - **Empty state** — the most-seen screen out of the box, so it carries the teaching. Names
    `~/.francois/extensions/` in mono on its own line, one sentence of copy, and a pointer to the
    example (`examples/extensions/plugin-example/`). Quiet register, `EmptyPane` idiom, no accent — nothing is
    live yet.
  - **Row error state** — the `extensions` FR-49 register, reused verbatim so the two error
    surfaces read as one: the cause in the error tone (`invalid manifest · unknown primitive
    "tabel" at /panels/1/primitive`), then the manifest path in mono beneath. No `Retry` control
    here — the fix is editing the file, and `Re-detect` at the modal footer is what re-reads it.
  - The **`Re-detect`** control the modal already carries (`extensions` FR-57) keeps its place and
    gains the directory re-scan. Its copy does not change.

- **Consent dialog** — the gate. `src/ui/Modal`, the `RemoveAccountConfirm` register (small, centred,
  two buttons), deliberately NOT the session permission card — that one belongs to a Claude Code
  tool call and would mis-signal what is being authorized.
  - Header: the extension id + `wants to run these commands`.
  - Body: **every distinct argv, one per line, mono, unwrapped, horizontally scrollable**. Never
    wrapped and never truncated — a hidden flag is the exact thing this dialog exists to prevent.
    Rendered as inert text; nothing here is a link (`extensions` FR-52).
  - Beneath the list: the source path, mono, dim.
  - For consent `stale`: a leading line in the warn tone saying the manifest changed since it was
    last enabled. The list shows the **new** commands. No diff against the old set — the user is
    being asked to read what will run now, not to audit a change.
  - Buttons: `Cancel` (default focus) and `Enable`. **`Cancel` is the safe default and takes the
    focus**, inverting the usual affirmative-default — the whole point is that inattention leaves
    the extension off.
  - States: idle · confirming · **stale-under-the-dialog** (`EXT_CONSENT_STALE`: the file changed
    while the dialog was open — the dialog reloads its list in place and says so, rather than
    closing).

- **The `ext:<id>` tab body** — **unchanged**. `specs/extensions.md` §8 owns the four primitives,
  their section headers, the error register and the `disable` affordance. Nothing in this feature
  redraws them.

## Flows

1. ⌘K → `Extensions` → the modal opens on `Installed`.
2. A row reading `Review & enable` → click → consent dialog → read the commands → `Enable`.
3. The dialog closes, the row's control becomes a live toggle, the detection line resolves (a
   `commandSucceeds` predicate runs for the first time here), and the tab appears in the session row
   if it detects.
4. `Cancel` → dialog closes, nothing changed, nothing ran.
5. A plugin installed while the app is open → `Re-detect` at the modal footer → the row appears,
   disabled.
6. A manifest edited after consent → next launch → the row shows `changed since you enabled it` and
   its tab is gone until re-consented.

## Data shown

Per row: `id`, `label`, `source.dir`, `enabled`, `consent.state`, `detected`, `undetectedReason`,
`manifestError` (cause + `detail.pointer`). In the dialog: `source.declaredCommands` (each an
argv array, joined for display with a single space), `source.dir`. All from `ExtensionInfo` in
§5 — no field is derived in the view beyond joining argv and truncating the path.

## Notes / constraints

- **Copy in English**, sentence case, lower-case for the machine-ish strings (`available here`,
  `not evaluated — enable to detect`) matching the existing extension copy register.
- **No acid accent anywhere in this modal.** Acid means the live thing; a list of things that are
  mostly *not* running would dilute it. Enabled-and-detected reads in the ready green `#4fae86`,
  everything else in the muted register.
- The consent dialog must remain readable at the narrowest window the shell allows — the argv list
  scrolls horizontally rather than the dialog growing.
- Accessibility: the trailing control is the row's only tab stop; the row itself is not clickable,
  so there is no ambiguity about what enabling means.
- A row must never be hidden. An invalid manifest, an undetected predicate and an unconsented
  extension are all **listed** — the modal is the inventory of the directory, and a plugin that
  silently fails to appear is the failure mode this whole screen exists to prevent.

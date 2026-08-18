# DESIGN BRIEF — Endpoint accounts (`multi-provider-endpoint`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/multi-provider-endpoint.md`, standalone.

**Goal:** Register an OpenAI-compatible endpoint (label, base URL, API key, optional model list) as an
account, prove it works before saving, and see plainly that sessions on it are not available yet.

**Design system:** use the existing UI kit (`src/ui/`, tokens in `src/styles.css`). Visual source of
truth: `Francois Redesign.dc.html` + `Francois Design System v2.dc.html`; `Claude Terminal.dc.html`
for surfaces the redesign never re-drew. This is a **native desktop terminal app** — JetBrains Mono
throughout, dense, keyboard-first, no rounded-card web idiom. Nothing here is a new screen; every
element lands inside the existing Accounts modal and the existing pickers.

**The one rule this brief exists to hold:** *provider is metadata, not identity.* No vendor colour, no
vendor logo, no second visual species of account row. Acid `#c3f53f` stays the one live thing per
view and is **not** spent on the kind chip.

## Screens / views

### 1. Accounts modal — list rows (modified)

Purpose: tell the two kinds apart at a glance without making one look special.

- Elements
  - Existing row: label · email/organization · default marker · actions.
  - **New: kind chip** on endpoint rows only — small, neutral (dim border, dim text, no fill), text
    `endpoint`. OAuth rows get **no** chip; absence is the default reading, so nothing about existing
    accounts changes visually.
  - **New: not-yet note** — one dim line under the label on endpoint rows:
    `sessions not yet available`. Removed by `multi-provider-openai`.
  - **New: edit affordance** on endpoint rows (pencil, `lucide-react`, inherits `currentColor`).
    OAuth rows keep their existing re-login action instead.
- States
  - **Keyed** — the row reads `<baseUrl>` dim, middle-truncated.
  - **Keyless** — same, plus a dim `no key` marker. Not a warning: a loopback server may need none.
  - **Default account** — the existing default marker, unchanged and kind-agnostic.

### 2. Accounts modal — endpoint form (the primary new surface)

Purpose: add or edit an endpoint. Opens inline inside the modal (not a nested dialog), pushing the
list down; the modal's own header and footer stay put.

- Elements, in order
  - **Label** — text input. Placeholder `OpenAI`.
  - **Base URL** — text input, monospace. Placeholder `https://api.openai.com/v1`, dim hint below:
    *"usually ends in /v1"*.
  - **API key** — `type="password"`, never prefilled. Placeholder `••••••••  stored` when a key
    exists, `sk-…` otherwise. On edit, a **Clear key** text action sits beside the field; it is
    absent when there is no stored key.
  - **Models** — optional text input, comma-separated, monospace. Dim hint: *"leave empty to use the
    endpoint's own list"*.
  - **Action row** — `Test` (secondary) · `Save` (primary) · `Cancel` (ghost).
  - **Result line** — single line directly above the action row; the form's only feedback surface.
- States
  - **Empty / adding** — all fields blank, `Save` disabled until Label and Base URL are non-empty.
  - **Editing** — prefilled from the account; key field empty with the `stored` placeholder.
  - **Testing** — `Test` shows a spinner, both `Test` and `Save` disabled, result line reads
    `probing…`. Bounded at 10 s.
  - **Test OK** — result line, ready green `#4fae86`: `reachable · 12 models`. Zero models is the
    **same** success state, reading `reachable · 0 models` — not an error.
  - **Test failed** — result line, error tone, one sentence, no stack, no URL echo:
    `couldn't reach that URL` · `the endpoint rejected that key` · `endpoint answered 500`.
  - **Validation error** — the offending field takes the error border; the result line carries the
    rule, e.g. *"base URL must be https (http is allowed on localhost only)"*.
  - **Stale-cleared** — editing **any** field wipes the result line back to empty. A green from a
    previous URL must never survive a change.
  - **Saving** — `Save` disabled with a spinner; on `ACCOUNT_KEY_WRITE_FAILED` the form stays open,
    fields intact, result line explains, and nothing was created.

### 3. Account pickers — blocked row (new state, temporary)

Appears in the **New Session modal**'s account control and the **Projects modal**'s default-account
control. This whole state is deleted by `multi-provider-openai`.

- Elements: the normal account row, rendered disabled — label and base URL at dim, plus a dim reason
  line `Sessions on this provider aren't available yet.`
- Behaviour: visible but not selectable; **skipped** by ↑/↓ and by type-ahead; no hover affordance,
  no pointer cursor. It is not filtered out — the user must see the account they just created.

## Flows

1. Accounts modal → **Add endpoint** (secondary button beside the existing *Add account*) → form
   opens inline, focus lands on Label.
2. Fill Label + Base URL + key → **Test** → result line reports → **Save** → form closes, the new row
   appears in the list with its `endpoint` chip, and the list re-sorts as it already does.
3. Edit: pencil on a row → same form, prefilled, key field empty → change what's needed → **Test**
   (uses the stored key when the field is untouched) → **Save**.
4. Remove: the existing remove path, unchanged — the confirmation copy does not mention keys.
5. Try to use it: New Session modal → the endpoint row is visible, dim, with its reason, and the
   keyboard walks past it.

## Resize behaviour

Desktop-only app; there is no mobile breakpoint. The modal keeps its current width and the form
inherits it — inputs are full-width, the action row is right-aligned. The base URL and the result line
both middle-truncate rather than wrap; the modal never grows a horizontal scrollbar. At the smallest
supported window the form scrolls inside the modal body with the header/footer pinned.

## Data shown

Matches `specs/multi-provider-endpoint.md` §5 exactly: `Account.label`, `Account.kind`,
`Account.endpoint.baseUrl`, `Account.endpoint.hasKey`, `Account.endpoint.modelIds`,
`Account.isDefault`, and `EndpointProbe.modelCount`. **`EndpointProbe.models[]` is fetched but not
listed in v1** — only the count is shown. The API key is never displayed, never echoed back, never
part of an error message, and never in a tooltip.

## Notes / constraints

- **Copy is English**, sentence case, one sentence per error, no exclamation marks, no vendor names in
  chrome (`endpoint`, not `OpenAI`).
- **Accessibility:** the key field is a real `type="password"`; the result line is a polite live
  region so a screen reader announces the probe outcome; the disabled picker row is a native
  `<option disabled title={reason}>` with the reason also appended into the option's visible label
  (`— reason`) — `<option>` doesn't reliably expose custom ARIA attributes across screen readers, so
  the reason rides on the accessible name instead of a separate `aria-disabled` description. The row
  stays in the a11y tree and is skipped by keyboard nav like any disabled option.
- **Icons** are `lucide-react` by name, inheriting `currentColor` — tone set in
  `src/features/accounts/accounts.css`, never with a `color` prop.
- **No inline `style={{}}`** — BEM-lite classes in the feature stylesheet.
- Do not introduce a spinner component if one exists in `src/ui/`; look there first.

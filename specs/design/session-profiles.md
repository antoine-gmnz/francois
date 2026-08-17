# DESIGN BRIEF — Session profiles (`session-profiles`)

> The "spec return" — §8 of `specs/session-profiles.md`, standalone.

**Goal:** the user picks a named role (`agent-architect`) when creating a session and gets that
doctrine every time, visibly, instead of dropping to a shell alias outside Francois.

**Design system:** the existing UI kit (`src/ui/` — `Button`, `Chip`, `ChipGroup`, `ListRow`, `Modal`,
`PanelHeader`, `BadgePill`, `EmptyPane`, `HintBar`). Icons from `lucide-react`, inheriting
`currentColor`. Desktop app — **not** mobile-first; the window resizes, it does not reflow to a phone.
Reference: `Francois Design System v2.dc.html` for tokens, `Francois Redesign.dc.html` (turn 4) for
shell chrome, the Projects modal for the modal pattern this mirrors.

## Screens / views

### 1. Profiles modal — new

Sibling to the Projects modal, same chrome: `Modal` + `PanelHeader`, two columns (list left, editor
right).

- **List column** — one `ListRow` per profile: name, then a compact summary of what it presets
  (a replace-mode marker if it carries a system prompt, then model / effort / permission-mode /
  "N extra args" as present). Ordered by name, case-insensitive. A *New profile* action at the top.
- **Editor column** — grouped fields:
  - **Name** — single line, 1–60 chars.
  - **System prompt** — the primary element: a multi-line textarea, monospace (JetBrains Mono),
    resizable, ≤16384 chars with a live count that only becomes visible near the cap. Directly under
    it, the **replace-mode consequence notice** (FR-23): this text *replaces* Claude Code's built-in
    prompt, so CLAUDE.md framing and tool-use doctrine are gone and the slash-menu, question cards
    and permission cards may behave unlike a normal session. Persistent and factual — an advisory,
    not a dismissible warning and not an error tone.
  - **Model · Effort · Permission mode** — the same controls New Session already uses, each with an
    explicit "inherit" / unset state, because an absent field means "don't preset this".
  - **Extra args** — ONE single-line text field, pasted verbatim from an alias tail. Below it, the
    **parsed tokens** rendered as a read-only `ChipGroup` (one chip per resolved token), so the user
    sees exactly what will be appended to the argv. Chips appear after a successful save.
  - **Save / Delete** actions in the editor footer.
- **States**
  - *empty* — no profiles yet: `EmptyPane` explaining that a profile bundles a prompt + model +
    effort + permission mode under a name, with the *New profile* action.
  - *editing* / *dirty* — Save enabled only when something changed.
  - *denied flag* — inline error on the Extra args field naming the flag **and** the reason
    (e.g. `--model` — Francois owns this flag; set the model above instead). The save is refused;
    nothing is written. This is a field-level error, not a modal-level banner.
  - *unmodelled flag* — a non-blocking advisory beside the offending token chip: Francois does not
    model this flag; it is passed to `claude` as-is. Muted tone, never the error tone, never blocking.
  - *bounds / unterminated quote* — field-level `INVALID_INPUT` message on the offending field.
  - *deleting* — confirm inline; state that existing sessions created from it keep working.

### 2. New Session modal — amended

- One **profile control** added above the existing model/effort/permission-mode controls (a picker,
  matching how the account/project controls already read). Options: "No profile" plus every profile.
- Selecting a profile **pre-fills** those existing controls and leaves them fully editable — the
  visual language must read as *pre-filled*, not *locked*: no disabled states, no lock glyph.
- Under the picker, a compact line naming what the selection presets, including the replace-mode
  marker when it carries a prompt.
- **Project default** — when the project names a profile, the dialog opens with it already selected
  and its values already pre-filled, indistinguishable in kind from any other project default. The
  point is that it is *visible before create*; nothing is applied silently.
- *States*: no profiles exist ⇒ the control is present with only "No profile" (or is hidden entirely —
  designer's call, but it must not read as broken); a project default that no longer resolves ⇒ opens
  with no profile selected, no error shown.

### 3. Profile chip — sidebar card · fleet card · session-welcome header

The same chip in three places, **two tones**:

- **Session-welcome header (focused session)** — the **acid** treatment (`#c3f53f`) when the profile
  replaces the system prompt. One per view by construction, which is why acid is allowed here and
  only here. A profile that only presets model/effort renders as a plain chip.
- **Sidebar session card · fleet card** — always **neutral**, with a small replace-mode marker
  (a glyph or a dot, not a colour promotion). Repeatable surfaces never take acid: five replace-mode
  sessions must not produce five acid chips.
- The chip shows the **snapshotted name** and never resolves against the registry — a deleted
  profile's name still renders, in exactly the same tone. There is no "dangling" or dimmed state.
- Never use the "Ready" green (`#4fae86`) for a profile chip — status must never read as identity.

### 4. Command palette — two entries

- `Profiles…` → opens the Profiles modal.
- `New session with profile…` → a profile pick, then the New Session dialog with it selected.

## Flows

1. ⌘K → `Profiles…` → *New profile* → name + paste prompt → (optional model/effort/permission mode) →
   (optional paste alias tail into Extra args) → Save. A denied flag refuses inline with the reason;
   the user removes it and saves; the parsed-token chips appear.
2. New Session → profile picker → `agent-architect` → the model/effort/permission controls fill in →
   the user changes the model → Create. The card shows the `agent-architect` chip; the welcome header
   shows it in acid.
3. Under a project with a default profile: New Session opens with the profile already selected and
   pre-filled — the user can see it, change it, or clear it before creating.
4. The user deletes `agent-architect`. Its running sessions keep their chip, unchanged.

## Responsive

Desktop window resize only. The Profiles modal keeps the Projects modal's two-column behaviour and
its min/max widths; the system-prompt textarea takes the vertical slack. At the narrowest supported
window the columns stack list-above-editor, as the Projects modal already does. The chip truncates
with an ellipsis on a narrow sidebar and keeps its marker visible — the marker is never what gets cut.

## Data shown

Must match `specs/session-profiles.md` §5 exactly:

- **Profiles list / editor** — `SessionProfile`: `name`, `systemPrompt`, `modelId`, `effort`,
  `permissionMode`, `extraArgsRaw` (the field) and `extraArgs` (the token chips).
- **Bounds surfaced in the UI** — `MAX_PROFILE_NAME` 60, `MAX_SYSTEM_PROMPT` 16384,
  `MAX_EXTRA_ARGS_RAW` 4096.
- **Chip** — `SessionMeta.profile`: `name` and `replacesSystemPrompt` (which picks the tone/marker).
  Nothing else; in particular the chip never reads the prompt text.
- **Errors rendered inline** — `PROFILE_ARG_DENIED` (`detail.flag`, `detail.reason`),
  `INVALID_INPUT`, `PROFILE_NOT_FOUND`.

## Notes / constraints

- **Copy language: English** (`ui_language`).
- Feature CSS in `src/features/<feature>/<feature>.css`, BEM-lite, **no inline `style={{}}`** except
  for a runtime-computed token. Cap font-weight at 600 — 700 is off-system.
- The replace-mode notice is the mitigation for a deliberately accepted degradation. It must be
  impossible to author a system prompt without reading it — but it is informational, never a blocker
  and never styled as an error.
- Accessibility: the replace-mode distinction must not be carried by colour alone — the marker glyph
  is what makes it legible on the neutral surfaces, and acid is a reinforcement, not the signal.
- The Extra args field is deliberately one text input and not a row-per-arg list: pasting an alias
  tail whole is the entire point. The token chips are what make the parse visible.

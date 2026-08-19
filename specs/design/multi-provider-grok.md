# DESIGN BRIEF — xAI / Grok integration (`multi-provider-grok`)

> The "spec return" — §8 of `specs/multi-provider-grok.md`, standalone. **No fresh mockups are
> expected**: every surface here already exists and was drawn for `multi-provider-codex` or for the
> CLI-install card on this branch. This brief exists so the implementer knows *which* existing
> treatment to reuse, and where the one genuinely new sentence goes.

**Goal:** a user signs in to xAI through the `grok` CLI and runs sessions on it, with the app being
honest about what this runtime cannot do.

**Design system:** the existing UI kit (`src/ui/`) and per-feature CSS (`src/features/accounts/accounts.css`,
`src/features/conversation/`). Desktop-only app — not mobile-first, no breakpoints (see Responsive).

**Identity v2 constraints that bind here:** acid `#c3f53f` marks the ONE focused/singular surface per
view, never a repeated one — so a Grok row in the accounts list uses neutral + a marker, not acid.
Provider tiles carry identity, not status: the `xai` tile keeps `--hue-slate`, and may never borrow
`--success` / `--error` / `--accent`. Cap feature CSS at `font-weight: 600`.

## Screens / views

- **Accounts modal → kind picker** — the existing Add flow.
  - Elements: one new option, **Grok CLI**, alongside *Claude*, *Codex CLI* and *OpenAI-compatible
    endpoint*. Label field only — a Grok account has no URL and no key (spec FR-20).
  - States: default · label empty (Save disabled) · saving · error (`INVALID_INPUT`).
  - Reuse the *Codex CLI* option's layout verbatim; the two are the same trade.

- **Accounts modal → provider rail / xAI detail** — already drawn.
  - Elements: the `XA` tile (`--hue-slate`, monogram, unchanged); the **CLI tools card** shipped on
    this branch (`CliToolCard.tsx`); the account list for this provider.
  - The one change: xAI moves from *install-only* to a real sign-in route (spec FR-28), so the card's
    "Francois cannot drive grok for sessions yet" sentence must go. It is now false.

- **Account row (`kind: 'grok-cli'`)** — reuse the `codex-cli` row exactly.
  - States: **needs sign-in** (`signedIn: false` → a **Sign in** action) · **signed in** ·
    **auth failed** (`authFailedAt` set) · default-account marker · renaming.
  - `signedIn: false` and `authFailedAt` are different states and must not collapse into one: a fresh
    account has no credential *and* no failure, and reads "sign in first", not "broken".

- **New Session modal** — the account picker lists Grok accounts **enabled** (unlike endpoint
  accounts, which ship deliberately disabled). Selecting one repopulates the model picker from Grok's
  own catalog under that account's label; the list is never empty (spec FR-25).

- **SESSION transcript** — the standard blocks, with two notes:
  - Assistant text **streams** for this runtime (spec FR-14). Same live-typing treatment as a Claude
    Code turn — do not fall back to the whole-message write `codex` uses.
  - Tool cards go live then complete **in place**, addressed by `toolCallId`. A card's name uses Claude
    Code's vocabulary (`Read`/`Write`/`Edit`/`Grep`/`Glob`/`Bash`); an unrecognised tool kind renders
    the generic card rather than vanishing.
  - **NEW COPY — the only new visual element in this feature.** On Windows, one notice per session,
    before the first assistant block, in the existing system/notice block style (not an error, not a
    warning): OS sandboxing is unavailable on this platform, so the permission mode's guarantee is the
    model's cooperation. Once per session, never per turn.

- **Right-column panes [3]–[6] + usage bar** — the existing disabled-pane treatment, driven by
  `CAPABILITIES['grok']`.
  - Every reason is worded as a **current gap** ("not yet"), never as settled architecture.
  - The usage-bar reason must be specific to *this* runtime: a Grok CLI session bills against a
    SuperGrok / X Premium+ plan Francois cannot probe. Reusing `francois`' "bills per token, not
    against a plan" or `codex`' ChatGPT wording would be a lie.
  - The Permissions surface says the sandbox governs this runtime, not Francois' rules.

## Flows

1. xAI provider → CLI card → **Install grok** (already built) → card flips to installed.
2. Add → **Grok CLI** → label → Save → row appears with **Sign in**.
3. **Sign in** → `grok login` runs out of band in the browser → row flips to signed-in when
   `auth.json` lands. No spinner that can hang forever and no timeout: the round-trip is not ours.
4. New Session → pick the Grok account → pick a model → Create → send → text streams, tool cards
   resolve in place, context meter fills.

## Responsive

Not applicable — Francois is a native desktop window, and this feature adds no new layout region. The
modal keeps its existing min/max width behaviour; the transcript notice wraps like any other block.

## Data shown

Only fields from spec §5: `Account.label`, `kind`, `signedIn`, `authFailedAt`, `isDefault`; the model
catalog's `id` + label; `CliToolStatus.installed` / `version` / `npmPackage`; and the transcript blocks
translated from `GrokSessionUpdate`. **Never** a key, a token, or a path inside `GROK_HOME`.

## Notes / constraints

- UI language: **English**.
- Icons are `lucide-react`, inheriting `currentColor`; tone comes from CSS, never a `color` prop.
- No inline `style={{}}` — per-feature CSS with BEM-lite class names.
- Accessibility: **Sign in** is a real button, reachable by keyboard; the sandbox notice is content in
  the transcript flow, not a toast, so a screen reader encounters it in order.
- Nothing Grok-shaped crosses the IPC boundary — the view renders `SessionEvent`s it already knows, so
  no component learns a second vocabulary.
